const state = { role: 'teacher', filter: 'all', data: null, technician: null, previousData: null };
const $ = (selector) => document.querySelector(selector);

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem('theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
}

setTheme(localStorage.getItem('theme') || 'dark');

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Ошибка соединения');
  }
  return response.json();
}

function initials(name) { return name.split(' ').map((part) => part[0]).slice(0, 2).join(''); }
function statusLabel(item) {
  if (!item.present) return 'Отсутствует';
  if (item.work_status === 'busy') return 'В работе';
  if (item.work_status === 'away') return 'Отошёл';
  return 'Свободен';
}
function statusClass(item) { return !item.present ? 'absent' : item.work_status === 'busy' ? 'busy' : item.work_status === 'away' ? 'away' : ''; }
function requestStatusLabel(status) { return status === 'new' ? 'Новая' : status === 'in_progress' ? 'В работе' : 'Выполнено'; }
function completedBy(item) { return item.completed_by || item.assignee || 'Не указан'; }
function completedToday(item, technicianName) {
  if (item.status !== 'done' || completedBy(item) !== technicianName) return false;
  return item.completed_at ? new Date(item.completed_at).toDateString() === new Date().toDateString() : item.updated_at.startsWith('Сегодня');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function renderPersonCard(person) {
  const presence = person.present ? 'На месте' : 'Отсутствует';
  const status = person.status_text === 'Статус устарел'
    ? 'Отсутствует'
    : statusLabel(person);
  const schedule = person.schedule || {};
  const activeRequests = (state.data.requests || [])
    .filter((request) => request.assignee === person.name && request.status !== 'done');
  const workload = activeRequests.length
    ? `<small class="workload-line">Сейчас выполняет: ${activeRequests
      .map((request) => escapeHtml(request.title))
      .join(' · ')}</small>`
    : '<small class="workload-line">Активных заявок нет</small>';
  const controls = state.role === 'tech' ? `
    <div class="tech-actions">
      <button class="tech-control" data-presence="${person.id}">
        ${person.present ? 'Уйти' : 'Я на месте'}
      </button>
      <button class="tech-control" data-work="${person.id}">
        Изменить статус
      </button>
    </div>` : '';

  return `
    <article class="person">
      <div class="avatar">${initials(person.name)}</div>
      <div class="person-info">
        <div class="person-name">${escapeHtml(person.name)}</div>
        <div class="person-role">
          ${escapeHtml(person.role)}
          <span class="presence ${person.present ? 'online' : ''}">${presence}</span>
        </div>
        <small class="schedule-line">
          График: ${(schedule.days || []).join(', ')} ·
          ${schedule.from || '08:00'}–${schedule.to || '17:00'} ·
          Обновлено: ${person.last_status_update
            ? new Date(person.last_status_update).toLocaleString('ru-RU')
            : 'нет данных'}
        </small>
        ${workload}
      </div>
      <span class="status-badge ${statusClass(person)}">${status}</span>
      ${controls}
    </article>`;
}

function renderPeople() {
  $('#people-list').innerHTML = state.data.technicians
    .map(renderPersonCard)
    .join('');
  document.querySelectorAll('[data-presence]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.presence !== state.technician.id) return;
    const person = state.data.technicians.find((item) => item.id === button.dataset.presence);
    updateTechnician(person.id, { present: !person.present });
  }));
  document.querySelectorAll('[data-work]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.work !== state.technician.id) return;
    const person = state.data.technicians.find((item) => item.id === button.dataset.work);
    const next = person.work_status === 'free' ? 'busy' : person.work_status === 'busy' ? 'away' : 'free';
    updateTechnician(person.id, { work_status: next, status_text: next === 'busy' ? 'Занят заявкой' : next === 'away' ? 'Отошёл' : 'Готов помочь' });
  }));
}

async function updateTechnician(id, changes) {
  await api('/api/status', { method: 'POST', body: JSON.stringify({ id, ...changes }) });
  await refresh();
  showToast('Статус обновлён');
}

function renderRequestTools(item, comments, history) {
  if (state.role !== 'tech' || item.assignee !== state.technician.name) return '';

  const commentItems = comments.length
    ? comments.map((comment) => `
        <p>
          <strong>${escapeHtml(comment.by)}</strong>
          <span>${escapeHtml(comment.text)}</span>
          <small>${escapeHtml(comment.at)}</small>
        </p>`).join('')
    : '<p class="muted">Комментариев пока нет</p>';
  const historyItems = history.slice().reverse().map((event) => `
    <p>
      <strong>${escapeHtml(event.text)}</strong>
      <span>${escapeHtml(event.by)}</span>
      <small>${escapeHtml(event.at)}</small>
    </p>`).join('');

  return `
    <details class="request-details">
      <summary>Комментарии (${comments.length}) · История (${history.length})</summary>
      <div class="request-comments">
        ${commentItems}
        <form data-comment-form="${item.id}">
          <input name="text" placeholder="Добавить комментарий" required>
          <button type="submit" class="tech-control">Добавить</button>
        </form>
      </div>
      <div class="request-history">${historyItems}</div>
    </details>`;
}

function renderRequestCard(item) {
  const comments = item.comments || [];
  const history = item.history || [];
  const tools = renderRequestTools(item, comments, history);
  const priorityClass = item.priority === 'Срочно' ? 'urgent' : '';
  const canChangeStatus = state.role === 'tech'
    && item.assignee === state.technician.name;
  const requestAction = canChangeStatus && item.status === 'new'
    ? `<button class="state-button in_progress" data-take-request="${item.id}">
        Взять в работу
      </button>`
    : canChangeStatus && item.status === 'in_progress'
      ? `<button class="state-button in_progress" data-request="${item.id}">
          Завершить заявку
        </button>`
      : `<span class="state-button ${item.status}">${requestStatusLabel(item.status)}</span>`;

  return `
    <article class="request ${priorityClass}">
      <div class="request-main">
        <div class="request-icon">${item.priority === 'Срочно' ? '!' : '↗'}</div>
        <div class="request-content">
          <div class="request-title"><span class="request-number">Заявка №${escapeHtml(item.id)}</span>${escapeHtml(item.title)}</div>
          <div class="request-meta">
            <strong>${escapeHtml(item.room)}</strong> ·
            ${escapeHtml(item.author)} ·
            <span class="priority-label ${item.priority === 'Срочно' ? 'urgent-label' : ''}">
              ${escapeHtml(item.priority)}
            </span>
          </div>
          ${item.description ? `<p class="request-description">${escapeHtml(item.description)}</p>` : ''}
          ${item.assignee ? `<p class="request-assignee">Исполнитель: <strong>${escapeHtml(item.assignee)}</strong></p>` : ''}
          ${item.status === 'done' ? `<p class="request-completed">Выполнил: <strong>${escapeHtml(completedBy(item))}</strong></p>` : ''}
          ${tools}
        </div>
      </div>
      <div class="request-side">
        <span class="request-time">${escapeHtml(item.updated_at)}</span>
        ${requestAction}
      </div>
    </article>`;
}

function renderRequests() {
  const visibleRequests = state.data.requests;
  const requests = visibleRequests
    .filter((item) => state.filter === 'all' || item.status === state.filter);
  const counts = {
    all: state.data.requests.length,
    new: 0,
    in_progress: 0,
    done: 0,
  };
  visibleRequests.forEach((item) => counts[item.status]++);
  $('#count-all').textContent = counts.all;
  $('#count-new').textContent = counts.new;
  $('#count-progress').textContent = counts.in_progress;
  $('#count-done').textContent = counts.done;
  $('#global-new-count').textContent = counts.new;
  $('#requests-list').innerHTML = requests.length
    ? requests.map(renderRequestCard).join('')
    : '<div class="empty">Заявок в этом разделе пока нет</div>';
  document.querySelectorAll('[data-request]').forEach((button) => button.addEventListener('click', () => cycleRequest(Number(button.dataset.request))));
  document.querySelectorAll('[data-take-request]').forEach((button) => button.addEventListener('click', () => takeRequest(Number(button.dataset.takeRequest))));
  document.querySelectorAll('[data-comment-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = new FormData(form).get('text');
    await api('/api/requests/comment', { method: 'POST', body: JSON.stringify({ id: Number(form.dataset.commentForm), text, author: state.technician.name }) });
    await refresh();
    showToast('Комментарий добавлен');
  }));
}

async function updateRequest(id, changes) {
  await api('/api/requests/update', { method: 'POST', body: JSON.stringify({ id, ...changes, actor: state.technician.name }) });
  await refresh();
  showToast('Заявка обновлена');
}

async function takeRequest(id) {
  const request = state.data.requests.find((item) => item.id === id);
  if (!request || request.assignee !== state.technician.name || request.status !== 'new') return;
  await updateRequest(id, { status: 'in_progress' });
  showToast('Заявка взята в работу');
}

function renderStats() {
  const dashboard = $('#tech-dashboard');
  dashboard.hidden = state.role !== 'tech';
  if (state.role !== 'tech') return;
  const currentTechnician = state.data.technicians.find((item) => item.id === state.technician.id);
  if (currentTechnician) {
    $('#my-account-name').textContent = currentTechnician.name;
    $('#my-presence-status').textContent = currentTechnician.present
      ? 'Я на месте'
      : 'Меня нет на месте';
    $('#my-presence-status').className = `my-presence-status ${currentTechnician.present ? 'present' : 'absent'}`;
  }
  const stats = state.data.stats || {};
  $('#stat-new').textContent = stats.new || 0;
  $('#stat-progress').textContent = stats.in_progress || 0;
  $('#stat-today').textContent = stats.completed_today || 0;
  $('#stat-month').textContent = stats.completed_month || 0;
}

function renderAdmin() {
  const dashboard = $('#admin-dashboard');
  dashboard.hidden = state.role !== 'admin';
  if (state.role !== 'admin') return;
  $('#admin-technicians').innerHTML = state.data.technicians.map((person) => {
    const schedule = person.schedule || { days: [], from: '08:00', to: '17:00' };
    const workStats = (state.data.technician_stats || [])
      .find((item) => item.id === person.id) || { count: 0, requests: [] };
    const completedRequests = workStats.requests.length
      ? workStats.requests.map((item) => `
          <li>
            <strong>${escapeHtml(item.title)}</strong>
            <span>
              Кабинет ${escapeHtml(item.room)} · ${escapeHtml(item.author)}
              ${item.completed_at ? ` · ${escapeHtml(item.completed_at.replace('T', ' '))}` : ''}
            </span>
          </li>`).join('')
      : '<li class="muted">Выполненных заявок пока нет</li>';

    return `
      <article class="admin-technician">
        <div>
          <strong>${escapeHtml(person.name)}</strong>
          <small>${escapeHtml(person.id)}</small>
          <div class="completed-total">Выполнено заявок: <b>${workStats.count}</b></div>
          <details class="completed-details">
            <summary>Показать заявки</summary>
            <ul>${completedRequests}</ul>
          </details>
        </div>
        <form data-schedule-form="${person.id}" class="schedule-form">
          <input name="days" value="${escapeHtml(schedule.days.join(', '))}" placeholder="Пн, Вт, Ср">
          <input type="time" name="from" value="${schedule.from}">
          <input type="time" name="to" value="${schedule.to}">
          <button class="tech-control" type="submit">Сохранить график</button>
        </form>
        <form data-account-form="${person.id}" class="account-form">
          <input name="name" value="${escapeHtml(person.name)}" placeholder="Имя" required>
          <input name="login" value="${escapeHtml(person.login || '')}" placeholder="Логин" required>
          <input name="password" placeholder="Новый пароль (необязательно)">
          <button class="tech-control" type="submit">Сохранить профиль</button>
        </form>
        <button class="tech-control danger" data-delete-tech="${person.id}">Удалить</button>
      </article>`;
  }).join('');
  document.querySelectorAll('[data-schedule-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    await api('/api/admin/schedule', {
      method: 'POST',
      body: JSON.stringify({
        admin_id: state.technician.id,
        id: form.dataset.scheduleForm,
        days: values.days.split(',').map((day) => day.trim()).filter(Boolean),
        from: values.from,
        to: values.to,
      }),
    });
    await refresh(); showToast('Расписание сохранено');
  }));
  document.querySelectorAll('[data-account-form]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    await api('/api/admin/technician/update', {
      method: 'POST',
      body: JSON.stringify({ admin_id: state.technician.id, id: form.dataset.accountForm, ...values }),
    });
    await refresh(); showToast('Профиль техника сохранён');
  }));
  document.querySelectorAll('[data-delete-tech]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Удалить техника?')) return;
    await api('/api/admin/technician/delete', { method: 'POST', body: JSON.stringify({ admin_id: state.technician.id, id: button.dataset.deleteTech }) });
    await refresh(); showToast('Техник удалён');
  }));
}

function renderDailySummary() {
  const summary = $('#daily-summary');
  const count = state.role === 'tech' ? state.data.requests.filter((item) => completedToday(item, state.technician.name)).length : 0;
  summary.hidden = state.role !== 'tech';
  $('#daily-count').textContent = count;
}

function renderFilters() {
  const allFilter = document.querySelector('[data-filter="all"]');
  allFilter.hidden = false;
  document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === state.filter));
}

async function cycleRequest(id) {
  const request = state.data.requests.find((item) => item.id === id);
  if (!request || request.assignee !== state.technician.name || request.status === 'done') return;
  const next = request.status === 'new'
    ? { status: 'in_progress' }
    : { status: 'done', completed_by: state.technician.name };
  await api('/api/requests/update', { method: 'POST', body: JSON.stringify({ id, ...next, actor: state.technician.name }) });
  await refresh();
  const message = next.status === 'done'
    ? 'Заявка отмечена как выполненная'
    : next.status === 'in_progress'
      ? 'Заявка взята в работу'
      : 'Заявка возвращена в новые';
  showToast(message);
}

async function refresh() {
  const nextData = await api('/api/state');
  const previousNew = state.previousData?.stats?.new ?? nextData.stats?.new ?? 0;
  const newRequestArrived = state.previousData && nextData.stats?.new > previousNew;
  const statusChanged = state.previousData && nextData.requests.some((item) => {
    const previous = state.previousData.requests.find((oldItem) => oldItem.id === item.id);
    return previous && previous.status !== item.status;
  });
  state.previousData = nextData;
  state.data = nextData;
  renderPeople(); renderRequests(); renderDailySummary(); renderStats(); renderAdmin();
  $('#last-updated').textContent = `Обновлено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  if (newRequestArrived) showToast('Поступила новая заявка');
  else if (statusChanged) showToast('Статус заявки обновлён');
}

function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }

function setRole(role) {
  state.role = role;
    document.body.classList.toggle('admin-mode', role === 'admin');
  document.querySelectorAll('.role-button').forEach((item) => item.classList.toggle('active', item.dataset.role === role));
  renderFilters(); renderPeople(); renderRequests(); renderDailySummary(); renderStats(); renderAdmin();
}

document.querySelectorAll('.role-button').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.role === 'teacher') setRole('teacher');
  else if (state.technician && state.technician.role === button.dataset.role) setRole(button.dataset.role);
  else $('#login-dialog').showModal();
}));
document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; renderFilters(); renderRequests(); }));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const account = Object.fromEntries(new FormData(form));
    state.technician = await api('/api/login', { method: 'POST', body: JSON.stringify(account) });
    localStorage.setItem('support-session', JSON.stringify(state.technician));
    form.reset(); $('#login-dialog').close('success'); setRole(state.technician.role); showToast(`Выполнен вход: ${state.technician.name}`);
  } catch (error) { showToast(error.message); }
});
$('#new-request').addEventListener('click', () => $('#request-dialog').showModal());
$('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    await api('/api/requests', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset(); $('#request-dialog').close('sent'); await refresh(); showToast('Заявка отправлена в техподдержку');
  } catch (error) { showToast(error.message); }
});
$('#add-technician-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  await api('/api/admin/technician', { method: 'POST', body: JSON.stringify({ admin_id: state.technician.id, ...values }) });
  event.currentTarget.reset(); await refresh(); showToast('Техник добавлен');
});
$('#backup-data').addEventListener('click', async () => {
  const result = await api('/api/admin/backup', { method: 'POST', body: JSON.stringify({ admin_id: state.technician.id }) });
  showToast(`Резервная копия: ${result.file}`);
});
$('#export-data').addEventListener('click', () => { window.location.href = '/api/export.csv'; });
$('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$('#current-time').textContent = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const savedSession = localStorage.getItem('support-session');
if (savedSession) {
  try {
    state.technician = JSON.parse(savedSession);
    if (['tech', 'admin'].includes(state.technician.role)) state.role = state.technician.role;
  } catch {
    localStorage.removeItem('support-session');
  }
}
refresh().catch(() => showToast('Не удалось подключиться к серверу'));
setInterval(refresh, 15000);
