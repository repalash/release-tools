export * from './core';
export { Foo } from './Foo';
export { Bar } from './Bar.js';
export type { Baz } from "./Baz.d.ts";
export * from './mod';
export * from './mod.mjs';
export * as again from '../basic/Foo';
import data from './data.json';
import './side';
export declare const t: typeof import('./types').T;
export declare const u: import( "./core/util/" ).U;
export { x } from 'some-lib/sub';
/**
 * Example in a doc comment, left as it is:
 * import { Foo } from './nowhere'
 */
// import './nowhere'
export { data };
