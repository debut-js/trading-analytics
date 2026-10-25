/** Replace every IPv4 / IPv6 address in `text` with `[ip]`. IPv4 goes first so an IPv4-mapped IPv6 address loses its dotted part too. */
export declare function scrubPublic(text: string): string;
