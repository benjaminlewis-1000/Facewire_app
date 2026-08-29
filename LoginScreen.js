import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';

import {
  ISSUER,
  CLIENT_ID,
  SCOPES,
  API_BASE,
  REDIRECT_URI,
  getDiscovery,
  saveTokenResponse,
  refreshTokens,
  hasRefreshToken,
  authedFetch,
  signOut,
} from './auth';

// Required for the auth-session redirect to close the in-app browser tab.
WebBrowser.maybeCompleteAuthSession();

/**
 * After a token is obtained, pull the two bits of bootstrap data App.js
 * expects to find in AsyncStorage on mount.
 */
const fetchBootstrapData = async () => {
  const resp = await authedFetch(`${API_BASE}/mobile/labeling_groups/`);
  if (resp.networkError) {
    return { success: false, message: 'No connection — could not load your work list.' };
  }
  if (!resp.ok) {
    return { success: false, message: `Could not load work list (status ${resp.status}).` };
  }
  const data = await resp.json();
  if (!Array.isArray(data.groups)) {
    return { success: false, message: 'API response missing "groups".' };
  }
  await AsyncStorage.setItem('pv_groups', JSON.stringify(data.groups));

  // Name list is best-effort - not fatal if it fails.
  try {
    const namesResp = await authedFetch(`${API_BASE}/mobile/name_list/`);
    if (namesResp.ok) {
      const namesData = await namesResp.json();
      if (Array.isArray(namesData.name_list)) {
        await AsyncStorage.setItem('nameList', JSON.stringify(namesData.name_list));
      }
    }
  } catch (e) {
    console.warn('name_list fetch failed (non-fatal):', e);
  }

  return { success: true };
};

const LoginScreen = ({ onLoginSuccess }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('Starting up...');
  const [biometricReady, setBiometricReady] = useState(false);
  const [savedSession, setSavedSession] = useState(false);

  const discovery = AuthSession.useAutoDiscovery(ISSUER);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: CLIENT_ID,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      // No `prompt: 'consent'` -- the Authelia client is consent_mode:
      // implicit, so the consent screen is skipped unless we ask for it.
    },
    discovery
  );

  // One-time: log the redirect URI so it can be registered in Authelia.
  useEffect(() => {
    console.log('=== PhotoVerify OIDC redirect URI (register this in Authelia):');
    console.log(REDIRECT_URI);
  }, []);

  const finishLogin = useCallback(async () => {
    setStatusText('Loading your tagging queue...');
    const boot = await fetchBootstrapData();
    if (boot.success) {
      onLoginSuccess();
    } else {
      setError(boot.message);
      setLoading(false);
    }
  }, [onLoginSuccess]);

  // Attempt silent (biometric-gated) re-login from a stored refresh token.
  const tryBiometricLogin = useCallback(async () => {
    setError('');
    setLoading(true);
    setStatusText('Confirm your identity...');
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock PhotoVerify',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (!result.success) {
        if (result.error !== 'user_cancel') {
          setError(`Biometric unlock failed: ${result.error}`);
        }
        setLoading(false);
        return;
      }
      setStatusText('Refreshing session...');
      await refreshTokens();
      await finishLogin();
    } catch (e) {
      console.warn('Biometric/refresh login failed:', e);
      // Refresh token is dead/revoked - fall back to full browser login.
      await signOut();
      setSavedSession(false);
      setError('Your saved session has expired. Please sign in again.');
      setLoading(false);
    }
  }, [finishLogin]);

  // On mount: figure out whether we can offer the fast path.
  useEffect(() => {
    (async () => {
      try {
        const [hasHardware, isEnrolled, hasToken] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
          hasRefreshToken(),
        ]);
        const bio = hasHardware && isEnrolled;
        setBiometricReady(bio);
        setSavedSession(hasToken);

        if (hasToken && bio) {
          await tryBiometricLogin();
        } else if (hasToken && !bio) {
          // No biometrics configured, but we still have a valid refresh
          // token - just use it.
          setStatusText('Refreshing session...');
          await refreshTokens();
          await finishLogin();
        } else {
          setLoading(false);
        }
      } catch (e) {
        console.warn('Startup auth check failed:', e);
        await signOut().catch(() => {});
        setSavedSession(false);
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle the browser round-trip result.
  useEffect(() => {
    if (!response) return;
    if (response.type === 'error') {
      setError(`Sign-in failed: ${response.error?.message || response.params?.error || 'unknown error'}`);
      setLoading(false);
      return;
    }
    if (response.type === 'dismiss' || response.type === 'cancel') {
      setLoading(false);
      return;
    }
    if (response.type === 'success') {
      (async () => {
        try {
          setLoading(true);
          setStatusText('Completing sign-in...');
          const disco = discovery || (await getDiscovery());
          const tokenResponse = await AuthSession.exchangeCodeAsync(
            {
              clientId: CLIENT_ID,
              code: response.params.code,
              redirectUri: REDIRECT_URI,
              extraParams: { code_verifier: request.codeVerifier },
            },
            disco
          );
          await saveTokenResponse(tokenResponse);
          await finishLogin();
        } catch (e) {
          console.warn('Code exchange failed:', e);
          setError('Could not complete sign-in. Please try again.');
          setLoading(false);
        }
      })();
    }
  }, [response]); // eslint-disable-line react-hooks/exhaustive-deps

  const startBrowserLogin = async () => {
    setError('');
    setLoading(true);
    setStatusText('Opening Authelia...');
    const result = await promptAsync();
    // `response` effect above handles success/error; just clear the
    // spinner if the user backed out without a result.
    if (result.type !== 'success') {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007bff" />
        <Text style={styles.statusText}>{statusText}</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>PhotoVerify</Text>
      <Text style={styles.subtitle}>Sign in with your Authelia account</Text>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {savedSession && biometricReady && (
        <TouchableOpacity style={styles.primaryButton} onPress={tryBiometricLogin}>
          <Text style={styles.primaryButtonText}>Unlock with biometrics</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={savedSession && biometricReady ? styles.secondaryButton : styles.primaryButton}
        onPress={startBrowserLogin}
        disabled={!request}
      >
        <Text
          style={
            savedSession && biometricReady
              ? styles.secondaryButtonText
              : styles.primaryButtonText
          }
        >
          Sign in with Authelia
        </Text>
      </TouchableOpacity>

      {savedSession && (
        <TouchableOpacity
          style={styles.linkButton}
          onPress={async () => {
            await signOut();
            setSavedSession(false);
            setError('Saved session cleared.');
          }}
        >
          <Text style={styles.linkButtonText}>Forget saved session</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
    padding: 24,
  },
  title: { fontSize: 34, fontWeight: 'bold', color: '#333', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 36, textAlign: 'center' },
  statusText: { marginTop: 16, fontSize: 15, color: '#444' },
  errorText: {
    color: '#dc3545',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
    marginTop: 8,
  },
  primaryButton: {
    width: '100%',
    backgroundColor: '#007bff',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  secondaryButton: {
    width: '100%',
    backgroundColor: '#e9ecef',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryButtonText: { color: '#333', fontSize: 16, fontWeight: '600' },
  linkButton: { marginTop: 28, paddingVertical: 10 },
  linkButtonText: { color: '#007bff', fontSize: 15, textDecorationLine: 'underline' },
});

export default LoginScreen;
