import type { Many, none } from "stream-chain/defs.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";

declare module "stream-json/core/parser.js" {
  /**
   * The synchronous tokenizer behind `parser`, which stream-json 3 exports
   * without a declaration. Each call returns the tokens completed by `text`;
   * `none` flushes the end of input.
   */
  export function jsonParser(
    options?: ParserOptions,
  ): (text: string | typeof none) => Many<Token> | typeof none;
}
