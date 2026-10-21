import type { HopRequest, HopResponse, Resolver, UrlImportDeps } from '../../src/server/import/url';

/**
 * Name lookup and page fetch for the canonical-page check, without a network. The default answers every
 * address with a live page that has a title. `respond` decides what each hop returns.
 */
export interface FakeCanonical extends UrlImportDeps {
  hops: HopRequest[];
}

export const PAGE = (title: string | null = 'A live post') => `<!doctype html><html><head>${title === null ? '' : `<title>${title}</title>`}</head><body><h1>Hello</h1></body></html>`;

export function fakeCanonical(options: { respond?: (request: HopRequest) => HopResponse | Promise<HopResponse>; resolve?: Resolver } = {}): FakeCanonical {
  const hops: HopRequest[] = [];
  return {
    hops,
    resolve: options.resolve ?? (async () => [{ address: '93.184.216.34', family: 4 }]),
    fetchHop: async (request) => {
      hops.push(request);
      if (options.respond) return options.respond(request);
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: new TextEncoder().encode(PAGE()) };
    },
  };
}

export const liveCanonical = () => fakeCanonical();
