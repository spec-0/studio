import { config } from "zod/v4/core";

/**
 * The ACP library checks every message with zod, and zod compiles its checks
 * with `new Function` unless told not to. The app's content security policy
 * blocks that, so zod is switched to jitless mode, which checks the same things
 * without it.
 *
 * A module of its own, imported before the ACP library: the library builds its
 * schemas when it's first imported, and zod decides then.
 */
config({ jitless: true });
