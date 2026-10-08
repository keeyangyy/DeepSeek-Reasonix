import type { AgentPort, BrowserTab } from "../port/port";

const opening = new WeakMap<AgentPort, Promise<BrowserTab>>();

/** The one way this window asks the kernel for a tab. What is being opened is
 *  remembered until the kernel answers, so a column that needs a page to show
 *  takes that one rather than asking for another. */
export function openPage(port: AgentPort, url: string): Promise<BrowserTab> {
  const page = port.browserOpen(url, true);
  opening.set(port, page);
  const settled = () => {
    if (opening.get(port) === page) opening.delete(port);
  };
  page.then(settled, settled);
  return page;
}

/** A page for a column that has none: the one already on its way, else a blank. */
export function pageForEmptyColumn(port: AgentPort): Promise<BrowserTab> {
  return opening.get(port) ?? openPage(port, "about:blank");
}
