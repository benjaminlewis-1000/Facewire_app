import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
//
// SafeAreaProvider wraps the whole tree (login + main app) so every screen
// can read the status-bar / nav-bar insets via useSafeAreaInsets(). SDK 54+
// forces Android edge-to-edge, so the app draws behind the system bars and
// is responsible for its own insets.
function Root() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
