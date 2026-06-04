/** 使用帮助页：目录高亮（可选） */
const sections = document.querySelectorAll('.help-section[id]');
const tocLinks = document.querySelectorAll('.help-toc a[href^="#"]');

if (sections.length && tocLinks.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        tocLinks.forEach((a) => {
          a.classList.toggle('active', a.getAttribute('href') === `#${id}`);
        });
      });
    },
    { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
  );
  sections.forEach((s) => observer.observe(s));
}
