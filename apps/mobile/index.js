// Polyfills first: imports run in order, so crypto.getRandomValues exists before any app module loads.
import './src/polyfills';
import { registerRootComponent } from 'expo';
// Telemetry next, so crash reporting (when configured) is running before any screen renders.
import { wrapRoot } from './src/telemetry';
import App from './App';

registerRootComponent(wrapRoot(App));
