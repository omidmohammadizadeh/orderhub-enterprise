// Phase AU — Thin client over the HubRise OAuth endpoints. Lives in
// its own file so the Location settings modal doesn't grow a third
// `apiClient` import chain.

import { apiClient } from "./client";

export const hubriseClient = {
  /**
   * Returns the HubRise authorize URL for the given location. The
   * caller is responsible for sending the operator there (typically a
   * `window.location.href = …` or `window.open(…)`); we don't 302
   * from the API so a single-page route doesn't lose its query state
   * mid-flow.
   */
  connect: (locationId: string) =>
    apiClient
      .get<{ authorizeUrl: string }>(
        `/v1/integrations/hubrise/connect`,
        { params: { locationId } },
      )
      .then((r) => r.data.authorizeUrl),
};
