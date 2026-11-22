// Loaded before the stylesheet paints, so a chosen theme never flashes the other one first.
const theme = localStorage.getItem('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
