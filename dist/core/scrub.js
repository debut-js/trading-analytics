// Public strings. The report JSON is anonymous, but some warnings quote upstream text: Binance answers a
// request from a non-whitelisted address with "... request ip: 203.0.113.7" (-2015), and network errors
// name the peer ("connect ETIMEDOUT 203.0.113.7:443"). Every such string passes through `scrubPublic`
// before it is published, so the server's egress address never reaches the page.
/** Four dot-separated 1–3 digit groups. */
const IPV4 = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g;
const G = '[0-9a-f]{1,4}';
/**
 * IPv6: eight groups, or groups around a `::` (a `::` needs at least one group beside it). Neighbouring
 * letters and digits are not allowed, so times (07:37:58), timestamps, MACs and `std::vec` are left alone;
 * a colon right after the address ("2001:db8::1: refused") is fine.
 */
const IPV6 = new RegExp(`(?<![0-9a-z])(?:${G}(?::${G}){7}|${G}(?::${G}){0,6}::(?:${G}(?::${G}){0,6})?|::${G}(?::${G}){0,6})(?![0-9a-z])`, 'gi');
/** Replace every IPv4 / IPv6 address in `text` with `[ip]`. IPv4 goes first so an IPv4-mapped IPv6 address loses its dotted part too. */
export function scrubPublic(text) {
    return text.replace(IPV4, '[ip]').replace(IPV6, '[ip]');
}
