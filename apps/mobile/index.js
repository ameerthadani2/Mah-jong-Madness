// Polyfills first: imports run in order, so crypto.getRandomValues exists before any app module loads.
import './src/polyfills';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
