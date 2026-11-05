/**
 * The device side of sign-in: where credentials are kept, who this device is, and the
 * provider SDKs (Sign in with Apple, Google via the system browser). Everything that needs
 * React Native or Expo modules lives here so ./client.ts stays testable.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStoreNative from 'expo-secure-store';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { randomHex } from '@mjm/net';
import { APP_BUILD, APP_ID } from '../config';
import { currentLocale } from '../i18n';
import { memoryStore } from './store';
import type { DeviceInfo, SecureStore } from './types';

// On web the Google popup lands back on this page; this closes it and hands the result to the opener.
if (Platform.OS === 'web') {
  try {
    WebBrowser.maybeCompleteAuthSession();
  } catch {
    /* not in a browser */
  }
}

const fallback = memoryStore();

/** Keychain / Keystore on native (survives reinstalls on iOS), AsyncStorage on web. Values stay under 2 KB. */
export const platformStore: SecureStore =
  Platform.OS === 'web'
    ? {
        getItem: (k) => AsyncStorage.getItem(k),
        setItem: (k, v) => AsyncStorage.setItem(k, v),
        deleteItem: (k) => AsyncStorage.removeItem(k),
      }
    : {
        getItem: async (k) => {
          try {
            return await SecureStoreNative.getItemAsync(k);
          } catch {
            return fallback.getItem(k);
          }
        },
        setItem: async (k, v) => {
          try {
            await SecureStoreNative.setItemAsync(k, v, { keychainAccessible: SecureStoreNative.AFTER_FIRST_UNLOCK });
          } catch {
            await fallback.setItem(k, v);
          }
        },
        deleteItem: async (k) => {
          try {
            await SecureStoreNative.deleteItemAsync(k);
          } catch {
            /* nothing stored */
          }
          await fallback.deleteItem(k);
        },
      };

const DEVICE_KEY = 'mjm.deviceId';
let deviceId: Promise<string> | null = null;

function loadDeviceId(): Promise<string> {
  if (!deviceId) {
    deviceId = (async () => {
      try {
        const saved = await AsyncStorage.getItem(DEVICE_KEY);
        if (saved) return saved;
      } catch {
        /* make one below */
      }
      let id: string;
      try {
        id = Crypto.randomUUID();
      } catch {
        const h = randomHex(16);
        id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
      }
      try {
        await AsyncStorage.setItem(DEVICE_KEY, id);
      } catch {
        /* best effort */
      }
      return id;
    })();
  }
  return deviceId;
}

export async function deviceInfo(): Promise<DeviceInfo> {
  return { id: await loadDeviceId(), platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web', appBuild: APP_BUILD, locale: currentLocale() };
}

/** An identity token from a provider plus the raw nonce it was bound to. */
export interface ProviderCredential {
  token: string;
  nonce: string;
  email?: string;
}

/** Sign in with Apple exists only on iOS 13+ devices with the capability. */
export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

const cancelled = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
};

/** Apple gets sha256(nonce); the server gets the raw nonce and checks the token's hash against it. Null when the player cancels. */
export async function signInWithApple(): Promise<ProviderCredential | null> {
  const nonce = randomHex(16);
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  try {
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
    if (!cred.identityToken) throw new Error('Sign in with Apple returned no identity token.');
    return { token: cred.identityToken, nonce, email: cred.email ?? undefined };
  } catch (e) {
    if (cancelled(e)) return null;
    throw e;
  }
}

const GOOGLE = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' };

/**
 * Google's OpenID id token in the system browser. Web asks for the id token directly; native
 * apps use the code flow with PKCE and exchange the code (Google echoes the nonce in either).
 * Null when the player closes the browser.
 */
export async function signInWithGoogle(clientId: string): Promise<ProviderCredential | null> {
  const nonce = randomHex(16);
  const web = Platform.OS === 'web';
  const redirectUri = AuthSession.makeRedirectUri(web || !APP_ID ? {} : { native: `${APP_ID}:/oauthredirect` });
  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    scopes: ['openid', 'profile', 'email'],
    responseType: web ? AuthSession.ResponseType.IdToken : AuthSession.ResponseType.Code,
    usePKCE: !web,
    extraParams: { nonce },
  });
  const result = await request.promptAsync(GOOGLE);
  if (result.type !== 'success') return null;
  if (web) {
    const token = result.params.id_token;
    if (!token) throw new Error('Google returned no identity token.');
    return { token, nonce };
  }
  const tokens = await AuthSession.exchangeCodeAsync({ clientId, code: result.params.code ?? '', redirectUri, extraParams: { code_verifier: request.codeVerifier ?? '' } }, GOOGLE);
  if (!tokens.idToken) throw new Error('Google returned no identity token.');
  return { token: tokens.idToken, nonce };
}
