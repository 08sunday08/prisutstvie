const state = { data: null };
const $ = (selector) => document.querySelector(selector);
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
async function api(path, options = {}) { const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options }); if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Ошибка соединения'); } return response.json(); }
function techStatus(person) { if (!person.present) return ['Отсутствует', 'absent']; if (person.work_status === 'busy') return ['Занят', 'busy']; if (person.work_status === 'away') return ['Отошёл', 'away']; return ['Свободен', '']; }
function requestStatus(status) { return status === 'new' ? 'Новая' : status === 'in_progress' ? 'В работе' : 'Выполнено'; }
function render() {
  const { data } = state; const filter = $('#status-filter').value;
  $('#total-count').textContent = data.requests.length; $('#new-count').textContent = data.stats.new; $('#progress-count').textContent = data.stats.in_progress;
  $('#free-count').textContent = data.technicians.filter((p) => p.present && p.work_status === 'free').length;
  $('#technicians-list').innerHTML = data.technicians.map((person) => { const [label, cls] = techStatus(person); return `<div class="dispatcher-tech"><div><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.role)}</small></div><span class="dispatcher-status ${cls}"><i></i>${label}</span></div>`; }).join('');
  const requests = data.requests.filter((item) => filter === 'all' || item.status === filter);
  $('#requests-list').innerHTML = requests.length ? requests.map((item) => `<article class="dispatcher-request"><div class="dispatcher-request-top"><div><h3><span class="request-number">Заявка №${escapeHtml(item.id)}</span>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.room)} · ${escapeHtml(item.author)} · ${escapeHtml(item.priority)}</p></div><span class="status-chip ${item.status}">${requestStatus(item.status)}</span></div><p>${escapeHtml(item.description || 'Без дополнительных деталей')}</p><select data-assign="${item.id}"><option value="">Не назначен</option>${data.technicians.map((person) => `<option value="${escapeHtml(person.name)}" ${item.assignee === person.name ? 'selected' : ''}>${escapeHtml(person.name)}${person.present && person.work_status === 'free' ? ' · свободен' : ''}</option>`).join('')}</select><p>Назначен: <strong>${escapeHtml(item.assignee || 'не назначен')}</strong> · Обновлено: ${escapeHtml(item.updated_at)}</p></article>`).join('') : '<div class="empty">Заявок нет</div>';
  document.querySelectorAll('[data-assign]').forEach((select) => select.addEventListener('change', async () => { await api('/api/requests/update', { method: 'POST', body: JSON.stringify({ id: Number(select.dataset.assign), assignee: select.value, actor: 'Распределитель' }) }); await refresh(); toast('Исполнитель назначен'); }));
}
async function refresh() { state.data = await api('/api/state'); render(); }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 2400); }
function setTheme(theme) { document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); $('#theme-toggle').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'; }
$('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')); setTheme(localStorage.getItem('theme') || 'dark');
$('#login-button').addEventListener('click', () => $('#login-dialog').showModal()); $('#close-login').addEventListener('click', () => $('#login-dialog').close()); $('#status-filter').addEventListener('change', render);
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const account = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); if (account.role !== 'dispatcher') throw new Error('Нужна учетная запись распределителя'); localStorage.setItem('dispatcher-session', JSON.stringify(account)); $('#login-dialog').close(); $('#app').hidden = false; $('#login-message').hidden = true; $('#login-button').textContent = `Выйти (${account.name})`; await refresh(); toast('Выполнен вход'); } catch (error) { toast(error.message); } });
const savedSession = localStorage.getItem('dispatcher-session');
if (savedSession) {
  try {
    const account = JSON.parse(savedSession);
    if (account.role === 'dispatcher') {
      $('#app').hidden = false;
      $('#login-message').hidden = true;
      $('#login-button').textContent = `Выйти (${account.name})`;
      refresh().catch(() => toast('Не удалось подключиться к серверу'));
    }
  } catch {
    localStorage.removeItem('dispatcher-session');
  }
}
setInterval(() => { if (!$('#app').hidden) refresh().catch(() => toast('Не удалось обновить данные')); }, 15000);
