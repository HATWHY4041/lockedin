// Bounty Escrow — a CosmWasm (wasmvm 1.x, interface_version_8) contract for ME Network.
//
// A brand locks a creator-campaign budget on-chain. Creators submit their post link.
// The brand approves (instant payout) or rejects. If the brand stays silent past the
// review window, the creator can claim the payout themselves. After the deadline the
// brand can withdraw whatever is not paid or still reserved for pending submissions.
//
// Written in Zig (no floats, MVP wasm) because it targets ME's wasmvm 1.4 engine.

const std = @import("std");
const json = std.json;
const Allocator = std.mem.Allocator;

// ---------------------------------------------------------------- host imports
extern "env" fn db_read(key: u32) u32;
extern "env" fn db_write(key: u32, value: u32) void;
extern "env" fn db_remove(key: u32) void;
extern "env" fn addr_validate(source: u32) u32;
extern "env" fn debug(source: u32) void;

const Region = extern struct { offset: u32, capacity: u32, length: u32 };

const gpa = std.heap.wasm_allocator;

export fn interface_version_8() void {}

export fn allocate(size: usize) u32 {
    const buf = gpa.alloc(u8, if (size == 0) 1 else size) catch unreachable;
    const r = gpa.create(Region) catch unreachable;
    r.* = .{ .offset = @intCast(@intFromPtr(buf.ptr)), .capacity = @intCast(buf.len), .length = 0 };
    return @intCast(@intFromPtr(r));
}

export fn deallocate(ptr: u32) void {
    // Each call runs in a fresh instance, so leaking is fine and cheapest.
    _ = ptr;
}

fn consume(ptr: u32) []u8 {
    const r: *Region = @ptrFromInt(ptr);
    const p: [*]u8 = @ptrFromInt(r.offset);
    return p[0..r.length];
}

fn release(data: []const u8) u32 {
    const r = gpa.create(Region) catch unreachable;
    r.* = .{ .offset = @intCast(@intFromPtr(data.ptr)), .capacity = @intCast(data.len), .length = @intCast(data.len) };
    return @intCast(@intFromPtr(r));
}

// ---------------------------------------------------------------- storage helpers
fn storeGet(key: []const u8) ?[]u8 {
    const ptr = db_read(release(key));
    if (ptr == 0) return null;
    return consume(ptr);
}

fn storeSet(key: []const u8, value: []const u8) void {
    db_write(release(key), release(value));
}

// ---------------------------------------------------------------- chain types
const Coin = struct { denom: []const u8, amount: []const u8 };

const Env = struct {
    block: struct { height: u64, time: []const u8, chain_id: []const u8 },
    contract: struct { address: []const u8 },
};

const Info = struct { sender: []const u8, funds: []const Coin };

// ---------------------------------------------------------------- state
const Submission = struct {
    id: u32,
    creator: []const u8,
    post_url: []const u8,
    status: []const u8, // pending | approved | rejected | claimed
    submitted_at: u64,
    resolved_at: u64 = 0,
    note: []const u8 = "",
};

const Campaign = struct {
    id: u32,
    brand: []const u8,
    title: []const u8,
    brief: []const u8,
    required_tag: []const u8,
    denom: []const u8,
    payout: []const u8, // per creator, base units
    max_creators: u32,
    review_secs: u64,
    deadline: u64, // unix seconds
    created_at: u64,
    budget: []const u8,
    paid: []const u8,
    refunded: []const u8,
    paid_count: u32,
    pending_count: u32,
    closed: bool,
    submissions: []Submission,
};

// ---------------------------------------------------------------- messages
const InstantiateMsg = struct {};

const ExecuteMsg = union(enum) {
    create_campaign: struct {
        title: []const u8,
        brief: []const u8 = "",
        required_tag: []const u8 = "",
        payout: []const u8,
        max_creators: u32,
        review_secs: u64,
        deadline: u64,
    },
    submit: struct { campaign_id: u32, post_url: []const u8 },
    approve: struct { campaign_id: u32, submission_id: u32 },
    reject: struct { campaign_id: u32, submission_id: u32, reason: []const u8 = "" },
    claim: struct { campaign_id: u32, submission_id: u32 },
    withdraw: struct { campaign_id: u32 },
};

const QueryMsg = union(enum) {
    config: struct {},
    campaign: struct { id: u32 },
    campaigns: struct { start_after: ?u32 = null, limit: ?u32 = null },
};

// ---------------------------------------------------------------- response types
const Attr = struct { key: []const u8, value: []const u8 };

const BankSend = struct { bank: struct { send: struct { to_address: []const u8, amount: []const Coin } } };

const SubMsg = struct {
    id: u64 = 0,
    msg: BankSend,
    gas_limit: ?u64 = null,
    reply_on: []const u8 = "never",
};

const ContractError = error{
    BadRequest,
    OutOfMemory,
};

// a per-call error message
var err_msg: []const u8 = "unknown error";

fn fail(msg: []const u8) ContractError {
    err_msg = msg;
    return error.BadRequest;
}

// ---------------------------------------------------------------- number helpers (no floats)
fn parseU128(s: []const u8) ContractError!u128 {
    if (s.len == 0 or s.len > 39) return fail("invalid amount");
    var v: u128 = 0;
    for (s) |c| {
        if (c < '0' or c > '9') return fail("invalid amount");
        v = std.math.mul(u128, v, 10) catch return fail("amount overflow");
        v = std.math.add(u128, v, c - '0') catch return fail("amount overflow");
    }
    return v;
}

fn fmtU128(a: Allocator, v: u128) ContractError![]u8 {
    var buf: [40]u8 = undefined;
    var i: usize = buf.len;
    var x = v;
    if (x == 0) {
        i -= 1;
        buf[i] = '0';
    }
    while (x > 0) : (x /= 10) {
        i -= 1;
        buf[i] = @intCast('0' + (x % 10));
    }
    return a.dupe(u8, buf[i..]);
}

fn fmtU64(a: Allocator, v: u64) ContractError![]u8 {
    return fmtU128(a, v);
}

fn nowSecs(env: Env) ContractError!u64 {
    const nanos = try parseU128(env.block.time);
    return @intCast(nanos / 1_000_000_000);
}

// ---------------------------------------------------------------- persistence
fn campaignKey(a: Allocator, id: u32) ContractError![]u8 {
    return std.mem.concat(a, u8, &.{ "c:", try fmtU64(a, id) });
}

fn loadCount() ContractError!u32 {
    const raw = storeGet("count") orelse return 0;
    return @intCast(try parseU128(raw));
}

fn loadCampaign(a: Allocator, id: u32) ContractError!Campaign {
    const raw = storeGet(try campaignKey(a, id)) orelse return fail("campaign not found");
    return json.parseFromSliceLeaky(Campaign, a, raw, .{ .ignore_unknown_fields = true }) catch return fail("corrupt campaign state");
}

fn saveCampaign(a: Allocator, c: Campaign) ContractError!void {
    const raw = try json.Stringify.valueAlloc(a, c, .{});
    storeSet(try campaignKey(a, c.id), raw);
}

fn findSub(c: *Campaign, sid: u32) ContractError!*Submission {
    for (c.submissions) |*s| if (s.id == sid) return s;
    return fail("submission not found");
}

fn eql(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

fn validateAddr(a: Allocator, addr: []const u8) ContractError!void {
    _ = a;
    if (addr_validate(release(addr)) != 0) return fail("invalid address");
}

// ---------------------------------------------------------------- entry points
const Event = struct { type: []const u8 };

fn okResponse(a: Allocator, msgs: []const SubMsg, attrs: []const Attr) ContractError![]u8 {
    const empty: []const Event = &.{};
    const resp = .{ .messages = msgs, .attributes = attrs, .events = empty, .data = @as(?[]const u8, null) };
    return json.Stringify.valueAlloc(a, .{ .ok = resp }, .{});
}

fn errResponse(a: Allocator, msg: []const u8) u32 {
    const body = json.Stringify.valueAlloc(a, .{ .@"error" = msg }, .{}) catch unreachable;
    return release(body);
}

fn arena() Allocator {
    const st = struct {
        var ar: std.heap.ArenaAllocator = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    };
    return st.ar.allocator();
}

export fn instantiate(env_ptr: u32, info_ptr: u32, msg_ptr: u32) u32 {
    const a = arena();
    _ = env_ptr;
    _ = info_ptr;
    _ = msg_ptr;
    storeSet("count", "0");
    const out = okResponse(a, &.{}, &.{.{ .key = "action", .value = "instantiate" }}) catch return errResponse(a, "oom");
    return release(out);
}

export fn execute(env_ptr: u32, info_ptr: u32, msg_ptr: u32) u32 {
    const a = arena();
    const out = doExecute(a, consume(env_ptr), consume(info_ptr), consume(msg_ptr)) catch |e| {
        return errResponse(a, if (e == error.OutOfMemory) "out of memory" else err_msg);
    };
    return release(out);
}

export fn query(env_ptr: u32, msg_ptr: u32) u32 {
    const a = arena();
    const out = doQuery(a, consume(env_ptr), consume(msg_ptr)) catch |e| {
        return errResponse(a, if (e == error.OutOfMemory) "out of memory" else err_msg);
    };
    const enc = std.base64.standard.Encoder;
    const b64 = a.alloc(u8, enc.calcSize(out.len)) catch return errResponse(a, "oom");
    _ = enc.encode(b64, out);
    const body = json.Stringify.valueAlloc(a, .{ .ok = b64 }, .{}) catch return errResponse(a, "oom");
    return release(body);
}

fn payMsg(a: Allocator, to: []const u8, denom: []const u8, amount: []const u8) ContractError![]SubMsg {
    const coins = try a.alloc(Coin, 1);
    coins[0] = .{ .denom = denom, .amount = amount };
    const msgs = try a.alloc(SubMsg, 1);
    msgs[0] = .{ .msg = .{ .bank = .{ .send = .{ .to_address = to, .amount = coins } } } };
    return msgs;
}

fn doExecute(a: Allocator, env_raw: []u8, info_raw: []u8, msg_raw: []u8) ContractError![]u8 {
    const opts: json.ParseOptions = .{ .ignore_unknown_fields = true };
    const env = json.parseFromSliceLeaky(Env, a, env_raw, opts) catch return fail("bad env");
    const info = json.parseFromSliceLeaky(Info, a, info_raw, opts) catch return fail("bad info");
    const msg = json.parseFromSliceLeaky(ExecuteMsg, a, msg_raw, .{}) catch return fail("unknown or malformed message");
    const now = try nowSecs(env);

    switch (msg) {
        .create_campaign => |m| {
            if (m.title.len == 0 or m.title.len > 100) return fail("title must be 1-100 characters");
            if (m.brief.len > 1000) return fail("brief too long (max 1000)");
            if (m.required_tag.len > 100) return fail("required_tag too long");
            if (m.max_creators == 0 or m.max_creators > 200) return fail("max_creators must be 1-200");
            if (m.review_secs < 60 or m.review_secs > 30 * 86400) return fail("review window must be 1 minute to 30 days");
            if (m.deadline <= now + 60) return fail("deadline must be in the future");
            const payout = try parseU128(m.payout);
            if (payout == 0) return fail("payout must be positive");
            if (info.funds.len != 1) return fail("send exactly one coin as the campaign budget");
            const sent = try parseU128(info.funds[0].amount);
            const budget = std.math.mul(u128, payout, m.max_creators) catch return fail("budget overflow");
            if (sent != budget) return fail("sent funds must equal payout x max_creators");

            const id = (try loadCount()) + 1;
            storeSet("count", try fmtU64(a, id));
            const c = Campaign{
                .id = id,
                .brand = info.sender,
                .title = m.title,
                .brief = m.brief,
                .required_tag = m.required_tag,
                .denom = info.funds[0].denom,
                .payout = try fmtU128(a, payout),
                .max_creators = m.max_creators,
                .review_secs = m.review_secs,
                .deadline = m.deadline,
                .created_at = now,
                .budget = try fmtU128(a, budget),
                .paid = "0",
                .refunded = "0",
                .paid_count = 0,
                .pending_count = 0,
                .closed = false,
                .submissions = &.{},
            };
            try saveCampaign(a, c);
            return okResponse(a, &.{}, &.{
                .{ .key = "action", .value = "create_campaign" },
                .{ .key = "campaign_id", .value = try fmtU64(a, id) },
                .{ .key = "brand", .value = info.sender },
                .{ .key = "budget", .value = c.budget },
            });
        },
        .submit => |m| {
            var c = try loadCampaign(a, m.campaign_id);
            if (c.closed) return fail("campaign is closed");
            if (now >= c.deadline) return fail("campaign deadline has passed");
            if (eql(info.sender, c.brand)) return fail("brand cannot submit to its own campaign");
            if (m.post_url.len < 8 or m.post_url.len > 300) return fail("post_url must be 8-300 characters");
            if (!std.mem.startsWith(u8, m.post_url, "https://")) return fail("post_url must start with https://");
            if (c.paid_count + c.pending_count >= c.max_creators) return fail("all creator slots are taken");

            // one live submission per creator; a rejected one may be replaced
            var reuse: ?*Submission = null;
            for (c.submissions) |*s| {
                if (eql(s.creator, info.sender)) {
                    if (eql(s.status, "rejected")) {
                        reuse = s;
                    } else return fail("you already have a submission in this campaign");
                }
            }
            var sid: u32 = 0;
            if (reuse) |s| {
                sid = s.id;
                s.post_url = m.post_url;
                s.status = "pending";
                s.submitted_at = now;
                s.resolved_at = 0;
                s.note = "";
            } else {
                sid = @intCast(c.submissions.len + 1);
                const subs = try a.alloc(Submission, c.submissions.len + 1);
                @memcpy(subs[0..c.submissions.len], c.submissions);
                subs[c.submissions.len] = .{ .id = sid, .creator = info.sender, .post_url = m.post_url, .status = "pending", .submitted_at = now };
                c.submissions = subs;
            }
            c.pending_count += 1;
            try saveCampaign(a, c);
            return okResponse(a, &.{}, &.{
                .{ .key = "action", .value = "submit" },
                .{ .key = "campaign_id", .value = try fmtU64(a, c.id) },
                .{ .key = "submission_id", .value = try fmtU64(a, sid) },
                .{ .key = "creator", .value = info.sender },
            });
        },
        .approve => |m| {
            var c = try loadCampaign(a, m.campaign_id);
            if (!eql(info.sender, c.brand)) return fail("only the brand can approve");
            const s = try findSub(&c, m.submission_id);
            if (!eql(s.status, "pending")) return fail("submission is not pending");
            s.status = "approved";
            s.resolved_at = now;
            return payOut(a, &c, s, "approve");
        },
        .claim => |m| {
            var c = try loadCampaign(a, m.campaign_id);
            const s = try findSub(&c, m.submission_id);
            if (!eql(info.sender, s.creator)) return fail("only the creator can claim");
            if (!eql(s.status, "pending")) return fail("submission is not pending");
            if (now < s.submitted_at + c.review_secs) return fail("review window has not ended yet");
            s.status = "claimed";
            s.resolved_at = now;
            s.note = "auto-released: brand did not review in time";
            return payOut(a, &c, s, "claim");
        },
        .reject => |m| {
            var c = try loadCampaign(a, m.campaign_id);
            if (!eql(info.sender, c.brand)) return fail("only the brand can reject");
            const s = try findSub(&c, m.submission_id);
            if (!eql(s.status, "pending")) return fail("submission is not pending");
            if (now >= s.submitted_at + c.review_secs) return fail("review window has ended; the creator can now claim");
            if (m.reason.len > 300) return fail("reason too long");
            s.status = "rejected";
            s.resolved_at = now;
            s.note = m.reason;
            c.pending_count -= 1;
            try saveCampaign(a, c);
            return okResponse(a, &.{}, &.{
                .{ .key = "action", .value = "reject" },
                .{ .key = "campaign_id", .value = try fmtU64(a, c.id) },
                .{ .key = "submission_id", .value = try fmtU64(a, s.id) },
            });
        },
        .withdraw => |m| {
            var c = try loadCampaign(a, m.campaign_id);
            if (!eql(info.sender, c.brand)) return fail("only the brand can withdraw");
            if (now < c.deadline) return fail("budget is locked until the deadline");
            const budget = try parseU128(c.budget);
            const paid = try parseU128(c.paid);
            const refunded = try parseU128(c.refunded);
            const reserved = (try parseU128(c.payout)) * c.pending_count;
            const avail = budget - paid - refunded - reserved;
            if (avail == 0) return fail("nothing to withdraw (pending submissions stay reserved)");
            c.refunded = try fmtU128(a, refunded + avail);
            c.closed = true;
            try saveCampaign(a, c);
            const amt = try fmtU128(a, avail);
            return okResponse(a, try payMsg(a, c.brand, c.denom, amt), &.{
                .{ .key = "action", .value = "withdraw" },
                .{ .key = "campaign_id", .value = try fmtU64(a, c.id) },
                .{ .key = "amount", .value = amt },
            });
        },
    }
}

fn payOut(a: Allocator, c: *Campaign, s: *Submission, action: []const u8) ContractError![]u8 {
    const p = try parseU128(c.payout);
    c.paid = try fmtU128(a, (try parseU128(c.paid)) + p);
    c.paid_count += 1;
    c.pending_count -= 1;
    try saveCampaign(a, c.*);
    return okResponse(a, try payMsg(a, s.creator, c.denom, c.payout), &.{
        .{ .key = "action", .value = action },
        .{ .key = "campaign_id", .value = try fmtU64(a, c.id) },
        .{ .key = "submission_id", .value = try fmtU64(a, s.id) },
        .{ .key = "creator", .value = s.creator },
        .{ .key = "amount", .value = c.payout },
    });
}

fn doQuery(a: Allocator, env_raw: []u8, msg_raw: []u8) ContractError![]u8 {
    _ = env_raw;
    const msg = json.parseFromSliceLeaky(QueryMsg, a, msg_raw, .{}) catch return fail("unknown or malformed query");
    switch (msg) {
        .config => {
            return json.Stringify.valueAlloc(a, .{ .campaign_count = try loadCount(), .name = "bounty-escrow", .version = "0.1.0" }, .{});
        },
        .campaign => |m| {
            return json.Stringify.valueAlloc(a, try loadCampaign(a, m.id), .{});
        },
        .campaigns => |m| {
            const count = try loadCount();
            const limit: u32 = @min(m.limit orelse 30, 50);
            // newest first
            var start: u32 = count;
            if (m.start_after) |sa| start = if (sa > 0) sa - 1 else 0;
            var list: std.ArrayList(Campaign) = .empty;
            var id = start;
            while (id >= 1 and list.items.len < limit) : (id -= 1) {
                try list.append(a, try loadCampaign(a, id));
            }
            return json.Stringify.valueAlloc(a, .{ .campaigns = list.items }, .{});
        },
    }
}
