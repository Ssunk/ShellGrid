use crate::protocol::{command_line, read_command, Command};
use std::{
    fs::{File, OpenOptions},
    io::{Cursor, Read, Write},
    mem::size_of,
    os::windows::io::AsRawHandle,
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{BOOL, PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT},
        System::{
            Console::{
                GetStdHandle, SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
                STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::{GetNamedPipeServerProcessId, PeekNamedPipe},
            Threading::{
                CreateProcessW, GetExitCodeProcess, OpenProcess, ResumeThread, TerminateProcess,
                WaitForSingleObject, BELOW_NORMAL_PRIORITY_CLASS, CREATE_SUSPENDED,
                CREATE_UNICODE_ENVIRONMENT, NORMAL_PRIORITY_CLASS, PROCESS_INFORMATION,
                PROCESS_SYNCHRONIZE, STARTF_USESTDHANDLES, STARTUPINFOW,
            },
        },
    },
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct ChildGuard(Handle);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Also covers every failure between CreateProcess and assignment/resume.
        unsafe {
            let _ = TerminateProcess(self.0 .0, 1);
        }
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn alive(handle: &Handle) -> bool {
    unsafe { WaitForSingleObject(handle.0, 0) == WAIT_TIMEOUT }
}
fn send(pipe: &mut File, value: serde_json::Value) -> Result<(), ()> {
    serde_json::to_writer(&mut *pipe, &value).map_err(|_| ())?;
    pipe.write_all(b"\n").map_err(|_| ())?;
    pipe.flush().map_err(|_| ())
}

// A custom handler is not inherited by the new process. Do NOT use the inherited
// ignore-Ctrl+C flag or CREATE_NEW_PROCESS_GROUP: PowerShell must receive Ctrl+C.
unsafe extern "system" fn console_control(control: u32) -> BOOL {
    BOOL::from(control == CTRL_C_EVENT || control == CTRL_BREAK_EVENT)
}

pub fn run() -> Result<u32, ()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 || !args[0].starts_with(r"\\.\pipe\shellgrid-") {
        return Err(());
    }
    let main_pid: u32 = args[1].parse().map_err(|_| ())?;
    let host_pid: u32 = args[2].parse().map_err(|_| ())?;
    // Open once to guard against PID reuse; both handles must remain unsignaled.
    let parent =
        Handle(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, main_pid) }.map_err(|_| ())?);
    let host =
        Handle(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, host_pid) }.map_err(|_| ())?);
    if !alive(&parent) || !alive(&host) {
        return Err(());
    }
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&args[0])
        .map_err(|_| ())?;
    let mut server_pid = 0;
    unsafe {
        GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut server_pid)
            .map_err(|_| ())?;
    }
    if server_pid != host_pid {
        return Err(());
    }
    let result = supervise(&mut pipe, &parent, &host);
    if result.is_err() {
        // Fixed text only: no launch arguments, environment, terminal data or keys.
        let _ = send(
            &mut pipe,
            serde_json::json!({"type":"error","message":"无法启动受 Job Object 保护的终端进程"}),
        );
    }
    result
}

fn poll_command(pipe: &mut File, pending: &mut Vec<u8>) -> Result<Option<Command>, ()> {
    let mut available = 0;
    unsafe {
        PeekNamedPipe(
            HANDLE(pipe.as_raw_handle()),
            None,
            0,
            None,
            Some(&mut available),
            None,
        )
        .map_err(|_| ())?;
    }
    if available > 0 {
        let mut buffer = [0_u8; 4096];
        let count = pipe
            .read(&mut buffer[..available.min(4096) as usize])
            .map_err(|_| ())?;
        if count == 0 {
            return Err(());
        }
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() > 256 * 1024 {
            return Err(());
        }
    }
    if let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
        let line: Vec<u8> = pending.drain(..=end).collect();
        return read_command(&mut Cursor::new(line)).map(Some);
    }
    Ok(None)
}

fn supervise(pipe: &mut File, parent: &Handle, host: &Handle) -> Result<u32, ()> {
    // Duplicated synchronous Windows pipe handles serialize concurrent reads and
    // writes. Peek/read only available bytes on this thread, so a pending read
    // cannot deadlock the ready/exit reply or prevent the parent liveness checks.
    let mut pending = Vec::new();
    let startup_deadline = Instant::now() + Duration::from_secs(15);
    let start = loop {
        if !alive(parent) || !alive(host) || Instant::now() > startup_deadline {
            return Err(());
        }
        if let Some(command) = poll_command(pipe, &mut pending)? {
            break command;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let Command::Start {
        shell,
        args,
        cwd,
        focused,
    } = start
    else {
        return Err(());
    };
    if cwd.contains('\0') || cwd.trim().is_empty() {
        return Err(());
    }
    let mut line = command_line(&shell, &args)?;
    let application = wide(&shell);
    let directory = wide(&cwd);
    unsafe {
        SetConsoleCtrlHandler(Some(console_control), true).map_err(|_| ())?;
        let job = Handle(CreateJobObjectW(None, None).map_err(|_| ())?);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|_| ())?;
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: GetStdHandle(STD_INPUT_HANDLE).map_err(|_| ())?,
            hStdOutput: GetStdHandle(STD_OUTPUT_HANDLE).map_err(|_| ())?,
            hStdError: GetStdHandle(STD_ERROR_HANDLE).map_err(|_| ())?,
            ..Default::default()
        };
        let mut process = PROCESS_INFORMATION::default();
        let priority = if focused {
            NORMAL_PRIORITY_CLASS
        } else {
            BELOW_NORMAL_PRIORITY_CLASS
        };
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | priority,
            None,
            PCWSTR(directory.as_ptr()),
            &startup,
            &mut process,
        )
        .map_err(|_| ())?;
        let child = ChildGuard(Handle(process.hProcess));
        let primary_thread = Handle(process.hThread);
        AssignProcessToJobObject(job.0, child.0 .0).map_err(|_| ())?;
        // The shell is still suspended. Host sends created before allowing resume.
        send(
            pipe,
            serde_json::json!({"type":"ready","shellPid":process.dwProcessId}),
        )?;
        let mut resumed = false;
        loop {
            if !alive(parent) || !alive(host) {
                return Ok(1);
            }
            if !resumed && Instant::now() > startup_deadline {
                return Err(());
            }
            match poll_command(pipe, &mut pending) {
                Ok(Some(Command::Resume)) if !resumed => {
                    if ResumeThread(primary_thread.0) == u32::MAX {
                        return Err(());
                    }
                    resumed = true;
                }
                Ok(Some(Command::Close)) | Err(()) => return Ok(1),
                Ok(Some(_)) => return Err(()),
                Ok(None) => {}
            }
            if !alive(&child.0) {
                let mut code = 1;
                GetExitCodeProcess(child.0 .0, &mut code).map_err(|_| ())?;
                // All job handles are non-inheritable; dropping the sole job handle
                // also reaps descendants if PowerShell exits before they do.
                drop(job);
                let _ = send(pipe, serde_json::json!({"type":"exit","exitCode":code}));
                return Ok(code);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
