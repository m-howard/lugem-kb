import BrowserOnly from '@docusaurus/BrowserOnly';
import { type ReactElement, type ReactNode } from 'react';

import { AskWidget } from '../components/AskWidget';

/**
 * Wraps the whole site so the ask widget is available from every page.
 *
 * `@theme/Root` is Docusaurus's documented hook for this, and no `docusaurus swizzle` is needed —
 * module aliasing resolves it to this file and falls back to core's pass-through wrapper when it
 * is absent. It renders above the theme layout and is never remounted by client-side navigation,
 * which is what lets a reader follow a citation without losing the conversation.
 *
 * `BrowserOnly` keeps it out of the server-rendered HTML. The widget is UI rather than content,
 * so omitting it from the build output costs nothing for search engines and removes a whole class
 * of "window is not defined" build failures.
 *
 * @param props - `children` is the rest of the site.
 * @returns The site, with the widget mounted alongside it.
 */
export default function Root({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <>
      {children}
      <BrowserOnly>{() => <AskWidget />}</BrowserOnly>
    </>
  );
}
