// One query cache for the app, importable outside React (the basket refreshes
// the Orders tab after it drops an unpaid order).

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
