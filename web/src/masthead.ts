const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ROTATING_WORDS = ['forget', 'bother', 'hassle', 'regret'];

export function formatDateline(date: Date): string {
  const day = DAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[date.getMonth()];
  return `${day}, ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function renderMasthead(today: Date = new Date()): HTMLElement {
  const masthead = document.createElement('header');
  masthead.className = 'masthead';
  masthead.innerHTML = `
    <h1 class="masthead-title" id="wordmark">
      <span class="wordmark-stem">don't</span>
      <span class="wordmark-slot" id="slot" aria-hidden="true">
        <span class="wordmark-sizer" id="sizer">${ROTATING_WORDS[0]}</span>
      </span>
      <span class="wordmark-tagline" id="tagline"> — you're covered.</span>
    </h1>
    <div class="masthead-rule"></div>
    <p class="masthead-dateline">${formatDateline(today)}</p>
  `;
  return masthead;
}

export function startWordmarkAnimation(): void {
  const masthead = document.querySelector<HTMLElement>('.masthead');
  const title = masthead?.querySelector<HTMLElement>('#wordmark');
  const slot = masthead?.querySelector<HTMLElement>('#slot');
  const sizer = masthead?.querySelector<HTMLElement>('#sizer');
  const tagline = masthead?.querySelector<HTMLElement>('#tagline');
  if (!masthead || !title || !slot || !sizer || !tagline) return;

  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = false;

  function sleep(ms: number): Promise<void> {
    const effective = reduce ? Math.min(ms, 260) : ms;
    return new Promise(resolve => { setTimeout(resolve, effective); });
  }

  function makeWord(text: string): { el: HTMLElement; strike: HTMLElement } {
    const el = document.createElement('span');
    el.className = 'wordmark-word';
    el.textContent = text;
    const strike = document.createElement('span');
    strike.className = 'wordmark-strike';
    el.appendChild(strike);
    return { el, strike };
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    slot.querySelectorAll('.wordmark-word').forEach(node => node.remove());

    for (const word of ROTATING_WORDS) {
      sizer.textContent = word;
      const node = makeWord(word);
      slot.appendChild(node.el);

      await sleep(30);
      node.el.classList.add('is-in');
      await sleep(reduce ? 260 : 520);

      node.strike.classList.add('is-drawn');
      await sleep(reduce ? 200 : 520);

      await sleep(reduce ? 160 : 360);
      node.el.classList.remove('is-in');
      node.el.classList.add('is-out');
      await sleep(reduce ? 120 : 320);
      node.el.remove();
    }

    sizer.textContent = ROTATING_WORDS[0];
    const final = document.createElement('span');
    final.className = 'wordmark-word';
    final.textContent = ROTATING_WORDS[0];
    slot.appendChild(final);
    await sleep(30);
    final.classList.add('is-in');

    tagline.classList.add('is-in');

    title.classList.remove('animating');

    running = false;
  }

  run();
}
