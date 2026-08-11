// Copy buttons for the shipped commands. Each button carries its exact command
// in data-copy, so what lands on the clipboard is the runnable line rather than
// the rendered block with its prompts and syntax spans.
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    navigator.clipboard.writeText(btn.dataset.copy).then(function () {
      btn.textContent = 'copied';
      btn.classList.add('done');
      setTimeout(function () {
        btn.textContent = 'copy';
        btn.classList.remove('done');
      }, 1600);
    });
  });
});
