import { Suspense, lazy } from "react";
import { CONSOLE_ENABLED } from "./lib/appConfig";
import { PublicApp } from "./public/PublicApp";

/**
 * Surface switch. The default build is the PUBLIC consumer app; the
 * internal operator console mounts only when the build sets
 * VITE_CONSOLE_ENABLED=true (an operator's local machine). The console
 * is loaded lazily so a public visitor never downloads it, and the
 * public app contains no route to or mention of it.
 */
const ConsoleApp = lazy(() =>
  import("./ConsoleApp").then((m) => ({ default: m.ConsoleApp })),
);

export function App(): JSX.Element {
  if (CONSOLE_ENABLED) {
    return (
      <Suspense fallback={<p className="faint">Loading console…</p>}>
        <ConsoleApp />
      </Suspense>
    );
  }
  return <PublicApp />;
}
