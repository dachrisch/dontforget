const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDateline(date: Date): string {
  const day = DAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[date.getMonth()];
  return `${day}, ${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function renderMasthead(today: Date = new Date()): HTMLElement {
  const masthead = document.createElement('header');
  masthead.className = 'masthead';
  masthead.innerHTML = `
    <h1 class="masthead-title">dontforget</h1>
    <div class="masthead-rule"></div>
    <p class="masthead-dateline">${formatDateline(today)}</p>
  `;
  return masthead;
}
