/**
 * Where TaruBot's dashboard is (2.42.0), for /dashboard's link. main.ts builds it once at startup
 * from src/web/settings.ts's webSettings, the same parse startWeb uses, so the address only ever
 * comes from WEB_PUBLIC_ORIGIN and never from a request. Commands read it through dashboardKey
 * rather than importing the settings parser: the registration tool loads every command and must
 * never load web code (src/bot/discovery.ts).
 */
export class Dashboard {
  constructor(
    /**
     * The parsed WEB_PUBLIC_ORIGIN, without a trailing slash: an `https://` origin, or
     * `http://localhost` / `http://[::1]` (each with an optional port) in development. Null while
     * the web is off or its settings are invalid (startWeb reports those).
     */
    readonly origin: string | null,
  ) {}
}
