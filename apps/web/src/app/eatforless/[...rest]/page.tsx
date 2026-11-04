import { notFound } from "next/navigation";

// Any unknown path under the site (on eatforless.co.uk that's any unknown
// path at all) gets the Eat For Less 404, not the OrderHub one.
export default function Page() {
  notFound();
}
