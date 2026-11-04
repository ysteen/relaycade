#include <windows.h>
#include <stdio.h>
int wmain(void) {
    wchar_t *command = GetCommandLineW();
    if (*command == L'"') { command++; while (*command && *command != L'"') command++; if (*command) command++; }
    else while (*command && *command != L' ') command++;
    while (*command == L' ') command++;
    if (!*command) return 2;
    HANDLE job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_AFFINITY;
    limits.BasicLimitInformation.Affinity = 3;
    limits.JobMemoryLimit = (SIZE_T)1536 * 1024 * 1024;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 3;
    STARTUPINFOW start = {sizeof(start)};
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &start, &process)) return 4;
    if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 5); return 5; }
    ResumeThread(process.hThread);
    if (WaitForSingleObject(process.hProcess, 60000) == WAIT_TIMEOUT) { TerminateJobObject(job, 124); return 124; }
    DWORD code;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job);
    return (int)code;
}
