export declare const isIconName: (s: string) => boolean;
export interface TokenIcon {
    body: string | Buffer;
    type: string;
}
/** 'pending' = CoinGecko is still being asked; the route answers a short-lived 204 and the next page load gets the logo. */
export type TokenIconResult = TokenIcon | null | 'pending';
/** The background-variant SVG of `symbol` from the pack (`ADA`, `1INCH`, …; the client strips `USDT` and a `1000` multiplier), or null. */
export declare function tokenIconSvg(symbol: string): Promise<string | null>;
/** The coin's mark: the pack's SVG, else CoinGecko's logo, else CoinCap's, else null (the page keeps the coin's first letter). */
export declare function tokenIcon(symbol: string): Promise<TokenIconResult>;
