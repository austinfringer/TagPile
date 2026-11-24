import { mount } from 'svelte';
import './styles/main.scss';
import Login from './Login.svelte';

const app = mount(Login, {
  target: document.getElementById('app')!,
});

export default app;
