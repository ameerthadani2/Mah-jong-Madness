/** Adapts `react-native-purchases` to the `PurchasesLike` slice ./providers.ts is written against. */
import Purchases, { LOG_LEVEL, PRODUCT_CATEGORY, type PurchasesStoreProduct } from 'react-native-purchases';
import type { PurchasesLike, StoreProductLike } from './providers';

export function nativePurchases(): PurchasesLike {
  const byId = new Map<string, PurchasesStoreProduct>();
  return {
    configure: (o) => {
      if (__DEV__) void Purchases.setLogLevel(LOG_LEVEL.WARN);
      Purchases.configure({ apiKey: o.apiKey, appUserID: o.appUserID ?? null });
    },
    logIn: (id) => Purchases.logIn(id),
    getProducts: async (ids, category) => {
      const found = await Purchases.getProducts(ids, category === 'SUBSCRIPTION' ? PRODUCT_CATEGORY.SUBSCRIPTION : PRODUCT_CATEGORY.NON_SUBSCRIPTION);
      for (const p of found) byId.set(p.identifier, p);
      return found.map((p): StoreProductLike => ({ identifier: p.identifier, priceString: p.priceString }));
    },
    purchaseStoreProduct: (p) => {
      const real = byId.get(p.identifier);
      if (!real) return Promise.reject(new Error(`${p.identifier} was not loaded from the store`));
      return Purchases.purchaseStoreProduct(real);
    },
    restorePurchases: () => Purchases.restorePurchases(),
  };
}
