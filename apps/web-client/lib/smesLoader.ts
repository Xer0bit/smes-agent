type SmesLoaderVariant = 'typing' | 'bars' | 'dots';

interface SmesLoaderOptions {
  variant?: SmesLoaderVariant;
  text?: string;
  speed?: number;
}

export class SmesLoader {
  private el: HTMLElement;
  private variant: SmesLoaderVariant;
  private text: string;
  private speed: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame: number = 0;
  private running = false;

  constructor(el: HTMLElement, options: SmesLoaderOptions = {}) {
    this.el = el;
    this.variant = (el.dataset.variant as SmesLoaderVariant) || options.variant || 'typing';
    this.text = options.text || 'Loading';
    this.speed = options.speed || 400;
    this.el.classList.add('smes-loader');
    this.el.dataset.variant = this.variant;
    this.build();
  }

  private build() {
    this.el.innerHTML = '';
    switch (this.variant) {
      case 'typing': {
        const track = document.createElement('span');
        track.className = 'smes-loader__track';
        const label = document.createElement('span');
        label.className = 'smes-loader__label';
        label.textContent = this.text;
        const dots = document.createElement('span');
        dots.className = 'smes-loader__dots';
        const cursor = document.createElement('span');
        cursor.className = 'smes-loader__cursor';
        track.append(label, dots, cursor);
        this.el.append(track);
        break;
      }
      case 'bars': {
        for (let i = 0; i < 4; i++) {
          const bar = document.createElement('span');
          bar.className = 'smes-loader__bar';
          bar.style.animationDelay = `${i * 120}ms`;
          this.el.append(bar);
        }
        break;
      }
      case 'dots': {
        for (let i = 0; i < 3; i++) {
          const dot = document.createElement('span');
          dot.className = 'smes-loader__dot';
          dot.style.animationDelay = `${i * 150}ms`;
          this.el.append(dot);
        }
        break;
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.el.classList.add('smes-loader--active');
    if (this.variant === 'typing') {
      this.timer = setInterval(() => this.tick(), this.speed);
    }
  }

  stop() {
    this.running = false;
    this.el.classList.remove('smes-loader--active');
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frame = 0;
    const dots = this.el.querySelector('.smes-loader__dots');
    if (dots) dots.textContent = '';
  }

  replay() {
    this.stop();
    this.start();
  }

  setProgress(p: number) {
    const clamped = Math.max(0, Math.min(1, p));
    this.el.style.setProperty('--progress', String(clamped));
    if (this.variant === 'typing') {
      const dots = this.el.querySelector('.smes-loader__dots');
      if (dots) dots.textContent = '.'.repeat(Math.round(clamped * 3));
    }
  }

  private tick() {
    this.frame = (this.frame + 1) % 4;
    const dots = this.el.querySelector('.smes-loader__dots');
    if (dots) dots.textContent = '.'.repeat(this.frame);
  }
}
