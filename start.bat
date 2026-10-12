@echo off
chcp 65001 > nul
title Техподдержка Одинцовского техникума
cd /d "%~dp0"

where py > nul 2>&1
if errorlevel 1 goto check_python
set "PYTHON=py -3"
goto run

:check_python
where python > nul 2>&1
if errorlevel 1 goto install_python
set "PYTHON=python"
goto run

:install_python
echo Python не найден. Пытаюсь установить Python 3 через winget...
where winget > nul 2>&1
if errorlevel 1 goto no_winget

winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto install_failed

set "PATH=%LocalAppData%\Programs\Python\Python312;%LocalAppData%\Programs\Python\Python312\Scripts;%PATH%"
where py > nul 2>&1
if errorlevel 1 goto check_installed_python
set "PYTHON=py -3"
goto run

:check_installed_python
where python > nul 2>&1
if errorlevel 1 goto install_failed
set "PYTHON=python"
goto run

:no_winget
echo Не удалось найти winget.
echo Установите Python 3 вручную с сайта https://www.python.org/downloads/windows/
pause
exit /b 1

:install_failed
echo Не удалось установить Python.
pause
exit /b 1

:run
echo Запуск сервера. Windows автоматически выберет свободный порт.
for /f "delims=" %%P in ('%PYTHON% -c "import sys; print(sys.executable)"') do set "PYTHON_EXE=%%P"
if defined PYTHON_EXE (
	netsh advfirewall firewall add rule name="Техподдержка Python" dir=in action=allow program="%PYTHON_EXE%" profile=private enable=yes > nul 2>&1
	if errorlevel 1 echo Не удалось автоматически добавить правило Firewall. Разрешите Python вручную для частной сети.
)
if exist server-error.log del /q server-error.log
%PYTHON% -u app.py > server-error.log 2>&1

if exist server-error.log (
	echo.
	echo Сервер завершился. Вывод Python:
	echo ----------------------------------------
	if exist server-error.log type server-error.log
	echo ----------------------------------------
	echo Полный вывод сохранён в server-error.log
)
pause