import { api, describeError } from '../network/api';
import { $, Disposer, setLoading, showError } from '../ui/dom';
import { toast } from '../ui/toast';
import type { AppContext, Route, Screen } from './types';

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export class AuthScreen implements Screen {
  private readonly disposer = new Disposer();
  private next = '#/lobby';

  constructor(private readonly ctx: AppContext) {}

  mount(route: Route): void {
    if (this.ctx.user) {
      this.ctx.navigate('#/lobby');
      return;
    }
    const next = route.query.get('next');
    this.next = next && next.startsWith('#/') ? next : '#/lobby';
    this.selectTab(route.query.get('modo') === 'registro' ? 'register' : 'login');
    if (route.query.get('motivo') === 'protegida') {
      showError($('[data-testid="login-error"]'), 'Inicia sesión para entrar en las salas.');
    }

    this.disposer.on($('#tab-login'), 'click', () => this.selectTab('login'));
    this.disposer.on($('#tab-register'), 'click', () => this.selectTab('register'));

    const loginForm = $<HTMLFormElement>('#login-form');
    this.disposer.on(loginForm, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      void this.login(loginForm);
    });
    const registerForm = $<HTMLFormElement>('#register-form');
    this.disposer.on(registerForm, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      void this.register(registerForm);
    });
  }

  private selectTab(tab: 'login' | 'register'): void {
    $('#tab-login').setAttribute('aria-selected', String(tab === 'login'));
    $('#tab-register').setAttribute('aria-selected', String(tab === 'register'));
    $('#login-form').hidden = tab !== 'login';
    $('#register-form').hidden = tab !== 'register';
    showError($('[data-testid="login-error"]'), null);
    showError($('[data-testid="register-error"]'), null);
    const first = $(tab === 'login' ? '[data-testid="login-username"]' : '[data-testid="register-username"]');
    (first as HTMLInputElement).focus({ preventScroll: true });
  }

  private async login(form: HTMLFormElement): Promise<void> {
    const errorEl = $('[data-testid="login-error"]');
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!username || !password) {
      showError(errorEl, 'Escribe tu usuario y tu contraseña.');
      return;
    }
    const button = $<HTMLButtonElement>('[data-testid="login-submit"]');
    setLoading(button, true);
    showError(errorEl, null);
    try {
      const { user } = await api.login(username, password);
      form.reset();
      this.ctx.setUser(user);
      toast(`Sesión iniciada como ${user.username}`, 'ok');
      this.ctx.navigate(this.next);
    } catch (error) {
      showError(errorEl, describeError(error));
      ($('[data-testid="login-password"]') as HTMLInputElement).select();
    } finally {
      setLoading(button, false);
    }
  }

  private async register(form: HTMLFormElement): Promise<void> {
    const errorEl = $('[data-testid="register-error"]');
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const confirm = String(data.get('confirm') ?? '');
    const usernameInput = $<HTMLInputElement>('[data-testid="register-username"]');
    const passwordInput = $<HTMLInputElement>('[data-testid="register-password"]');
    usernameInput.removeAttribute('aria-invalid');
    passwordInput.removeAttribute('aria-invalid');

    if (!USERNAME_RE.test(username)) {
      usernameInput.setAttribute('aria-invalid', 'true');
      showError(errorEl, 'El usuario debe tener 3-20 caracteres: letras sin tilde, números o guion bajo.');
      return;
    }
    if (password.length < 8) {
      passwordInput.setAttribute('aria-invalid', 'true');
      showError(errorEl, 'La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirm) {
      showError(errorEl, 'Las contraseñas no coinciden.');
      return;
    }
    const button = $<HTMLButtonElement>('[data-testid="register-submit"]');
    setLoading(button, true);
    showError(errorEl, null);
    try {
      const { user } = await api.register(username, password);
      form.reset();
      this.ctx.setUser(user);
      toast(`Cuenta creada. Bienvenido, ${user.username}`, 'ok');
      this.ctx.navigate(this.next);
    } catch (error) {
      showError(errorEl, describeError(error));
    } finally {
      setLoading(button, false);
    }
  }

  unmount(): void {
    this.disposer.dispose();
  }
}
