/* Sync, in <head>: marks the page as scripted so the reveal motion only runs with JS. No inline script anywhere: this file
   is the one initialiser; a site adds its own scripts (analytics, strings) through the head slot. */
document.documentElement.classList.add('js');
