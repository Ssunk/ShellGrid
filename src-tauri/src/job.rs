#[cfg(windows)]
mod platform {
    use std::mem::size_of;
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        },
    };

    pub struct Job(HANDLE);

    // Handles are kernel-managed and the methods used here are thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn for_process(process_id: u32) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(None, None).map_err(|error| error.to_string())?;
                let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if let Err(error) = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &information as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) {
                    let _ = CloseHandle(handle);
                    return Err(error.to_string());
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, process_id)
                    .map_err(|error| {
                        let _ = CloseHandle(handle);
                        error.to_string()
                    })?;
                let result = AssignProcessToJobObject(handle, process);
                let _ = CloseHandle(process);
                if let Err(error) = result {
                    let _ = CloseHandle(handle);
                    return Err(error.to_string());
                }
                Ok(Self(handle))
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub struct Job;

    impl Job {
        pub fn for_process(_process_id: u32) -> Result<Self, String> {
            Ok(Self)
        }
    }
}

pub use platform::Job;
