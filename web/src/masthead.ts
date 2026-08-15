const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const BASE_WORD = 'forget';
const STRUCK_WORDS = ['bother', 'hassle', 'regret'];
const PAYOFF_WORD = "you're covered.";

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
        <span class="wordmark-sizer" id="sizer">${BASE_WORD}</span>
      </span>
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
  const stem = title?.querySelector<HTMLElement>('.wordmark-stem');
  if (!masthead || !title || !slot || !sizer) return;

  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = false;

  function sleep(ms: number): Promise<void> {
    const effective = reduce ? Math.min(ms, 260) : ms;
    return new Promise(resolve => { setTimeout(resolve, effective); });
  }

  function makeStruckWord(text: string): { el: HTMLElement; strike: HTMLElement } {
    const el = document.createElement('span');
    el.className = 'wordmark-word';
    el.textContent = text;
    const strike = document.createElement('span');
    strike.className = 'wordmark-strike';
    el.appendChild(strike);
    return { el, strike };
  }

  function makePayoff(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'wordmark-word wordmark-payoff';
    el.textContent = text;
    return el;
  }

  async function showStruckWord(word: string): Promise<{ el: HTMLElement }> {
    sizer.textContent = word;
    const node = makeStruckWord(word);
    slot.appendChild(node.el);
    await sleep(30);
    node.el.classList.add('is-in');
    await sleep(reduce ? 260 : 520);
    node.strike.classList.add('is-drawn');
    await sleep(reduce ? 200 : 520);
    await sleep(reduce ? 160 : 360);
    return node;
  }

  async function cycleStruck(word: string): Promise<void> {
    const node = await showStruckWord(word);
    node.el.classList.add('is-out');
    await sleep(reduce ? 120 : 340);
    node.el.remove();
  }

  async function cyclePayoff(lastWord: string, text: string): Promise<void> {
    const node = await showStruckWord(lastWord);
    node.el.classList.add('is-out', 'is-exit-fast');
    stem?.classList.add('is-fading');
    await sleep(reduce ? 80 : 180);

    node.el.remove();
    stem?.classList.add('is-payoff-hidden');
    sizer.textContent = text;
    const el = makePayoff(text);
    slot.appendChild(el);
    await sleep(30);
    el.classList.add('is-in');
    await sleep(reduce ? 260 : 5000);

    el.classList.remove('is-in');
    el.classList.add('is-out');
    await sleep(reduce ? 120 : 340);
    el.remove();
    stem?.classList.remove('is-payoff-hidden', 'is-fading');
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    slot.querySelectorAll('.wordmark-word').forEach(node => node.remove());

    for (let i = 0; i < STRUCK_WORDS.length - 1; i++) {
      await cycleStruck(STRUCK_WORDS[i]);
    }
    await cyclePayoff(STRUCK_WORDS[STRUCK_WORDS.length - 1], PAYOFF_WORD);

    sizer.textContent = BASE_WORD;
    const final = document.createElement('span');
    final.className = 'wordmark-word';
    final.textContent = BASE_WORD;
    slot.appendChild(final);
    await sleep(30);
    final.classList.add('is-in');

    running = false;
  }

  run();
}
