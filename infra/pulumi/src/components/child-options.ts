import * as pulumi from '@pulumi/pulumi';

/**
 * Resource options for a child that used to be a top-level resource.
 *
 * A resource's URN includes its parent chain, so giving these resources a component parent renames
 * every one of them. Without the alias, an already-deployed stack would read that as thirty
 * deletions and thirty creations — including the corpus bucket and the knowledge base index.
 * `rootStackResource` is what says "this used to hang directly off the stack".
 *
 * New resources introduced after the component refactor must NOT use this: aliasing a URN that
 * never existed is noise in the state file and a lie to the next reader.
 *
 * @param parent - The component adopting the resource.
 * @returns Options pairing the new parent with the pre-refactor identity.
 *
 * @example
 * ```ts
 * new aws.s3.Bucket(`${name}-corpus`, { forceDestroy: false }, reparentedChild(this));
 * ```
 */
export function reparentedChild(parent: pulumi.Resource): pulumi.ResourceOptions {
  return { parent, aliases: [{ parent: pulumi.rootStackResource }] };
}
