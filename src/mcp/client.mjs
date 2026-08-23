/**
 * HTTP client for communicating with the running fitting editor server.
 */
export function createEditorClient(baseUrl = 'http://127.0.0.1:7391/') {
  const url = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  const request = async (path, options = {}) => {
    let res;
    try {
      const headers = { connection: 'close', ...options.headers };
      res = await fetch(new URL(path, url).href, { ...options, headers });
    } catch (e) {
      throw new Error(`No fitting editor is listening at ${url}. Start the editor with liverykit <livery> --ui.`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();

    if (!res.ok) {
      const errMsg = typeof data === 'object' && data?.error ? data.error : res.statusText;
      throw new Error(`Editor API error (${res.status}): ${errMsg}`);
    }

    return data;
  };

  return {
    baseUrl: url,
    checkEditor: async () => request('api/build'),
    getState: async () => request('api/state'),
    getTreatments: async () => request('api/treatments'),
    postProposal: async (proposal) => request('api/proposal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proposal),
    }),
    renderSurface: async (role, seed) => request('api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, seed }),
    }),
    previewSurfaces: async (seed) => request('api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed }),
    }),
  };
}
