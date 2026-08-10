import * as pulumi from '@pulumi/pulumi';

/**
 * Resolves a named group of string inputs, keeping the names.
 *
 * `pulumi.all` has two shapes and neither fits a container contract with a dozen values in it. Its
 * tuple overloads stop at eight and are destructured positionally, so adding a value anywhere but
 * the end silently shifts every later binding — the failure looks like a container whose
 * `CORPUS_BUCKET` holds a knowledge base id. Its record overload has no arity limit but returns
 * `Record<string, string>`, which under `noUncheckedIndexedAccess` makes every value possibly
 * `undefined` and hands the caller a pile of `?? ''` for keys that are always present.
 *
 * This is the record overload with its key names put back. The cast is narrow and describes what
 * the function actually does: every input here is a string, `Unwrap<string>` is `string`, and the
 * resolved object has exactly the keys it was given.
 *
 * @param values - Named string inputs.
 * @returns The same names, resolved.
 *
 * @example
 * ```ts
 * allStrings({ bucket: bucketName, arn: bucketArn }).apply(({ bucket, arn }) => `${bucket}:${arn}`);
 * ```
 */
export function allStrings<T extends Record<string, pulumi.Input<string>>>(
  values: T,
): pulumi.Output<{ readonly [K in keyof T]: string }> {
  return pulumi.all(values) as pulumi.Output<{ readonly [K in keyof T]: string }>;
}
