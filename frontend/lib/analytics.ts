/**
 * Google Analytics 4 events (gtag is loaded in app/layout.tsx).
 * Event names follow GA4's recommended ecommerce names where one exists,
 * so the Monetization reports fill in by themselves.
 * Never send personal data (email, name, phone, resume text) as a parameter.
 */

type GaItem = {
  item_id: string;
  item_name: string;
  item_category?: string;
  price: number;
  quantity: number;
  index?: number;
};

type GaParams = Record<string, string | number | boolean | undefined | GaItem[]>;

type Gtag = (command: "event", name: string, params?: GaParams) => void;

export function track(name: string, params: GaParams = {}): void {
  try {
    if (typeof window === "undefined") return;
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    if (typeof gtag === "function") gtag("event", name, params);
  } catch {
    // Analytics must never break the app.
  }
}

/** Fire an event only once per browser session for the given key (e.g. a purchase on page refresh). */
export function trackOnce(key: string, name: string, params: GaParams = {}): void {
  try {
    const storageKey = `ga_once_${key}`;
    if (sessionStorage.getItem(storageKey)) return;
    sessionStorage.setItem(storageKey, "1");
  } catch {
    // Storage blocked: still send it once for this page view.
  }
  track(name, params);
}

export function packageItem(
  pkg: { code: string; name: string; price_inr: number },
  index?: number,
): GaItem {
  return {
    item_id: pkg.code,
    item_name: `${pkg.name} credit pack`,
    item_category: "credit_pack",
    price: pkg.price_inr,
    quantity: 1,
    ...(index !== undefined ? { index } : {}),
  };
}

const CHECKOUT_KEY = "ga_checkout_";

/** Remember what was in the checkout so the return page can report the purchase value. */
export function rememberCheckout(orderId: string, item: GaItem): void {
  try {
    sessionStorage.setItem(CHECKOUT_KEY + orderId, JSON.stringify(item));
  } catch {}
}

export function recallCheckout(orderId: string): GaItem | null {
  try {
    const raw = sessionStorage.getItem(CHECKOUT_KEY + orderId);
    return raw ? (JSON.parse(raw) as GaItem) : null;
  } catch {
    return null;
  }
}
