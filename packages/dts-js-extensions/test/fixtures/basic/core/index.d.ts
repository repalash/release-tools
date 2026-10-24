import type { Foo } from '..';
export * from './util/';
declare module '../Foo' {
    interface Foo {
        extra: string;
    }
}
export type { Foo };
