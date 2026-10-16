//! Native OS credential-store operations. Secret values are never printed.

use crate::util;
use clap::{Args as ClapArgs, Subcommand};
use std::path::PathBuf;
use zeroize::Zeroizing;

const SERVICE: &str = "eule-mcp";

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write a credential to an owner-only file for local connector use.
    Get { reference: String, out: PathBuf },
    /// Delete a credential from the OS store.
    Delete { reference: String },
    /// Report whether a credential exists without exposing its value.
    Status { reference: String },
}

pub fn set(reference: &str, secret: &str) -> Result<(), String> {
    validate_reference(reference)?;
    keyring::Entry::new(SERVICE, reference)
        .map_err(|e| format!("opening OS credential store: {e}"))?
        .set_password(secret)
        .map_err(|e| format!("storing credential: {e}"))
}

/// Read a credential into zeroizing memory for native helper use. Callers must
/// never print or serialize the returned value.
pub fn get(reference: &str) -> Result<Zeroizing<String>, String> {
    validate_reference(reference)?;
    keyring::Entry::new(SERVICE, reference)
        .map_err(|e| format!("opening OS credential store: {e}"))?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|e| format!("reading credential {reference}: {e}"))
}

pub fn run(args: Args) -> Result<(), String> {
    match args.command {
        Command::Get { reference, out } => {
            let secret = get(&reference)?;
            util::write_secure(&out, secret.as_str())
                .map_err(|e| format!("writing credential: {e}"))
        }
        Command::Delete { reference } => {
            validate_reference(&reference)?;
            keyring::Entry::new(SERVICE, &reference)
                .map_err(|e| format!("opening OS credential store: {e}"))?
                .delete_credential()
                .map_err(|e| format!("deleting credential {reference}: {e}"))
        }
        Command::Status { reference } => {
            validate_reference(&reference)?;
            match keyring::Entry::new(SERVICE, &reference)
                .map_err(|e| format!("opening OS credential store: {e}"))?
                .get_password()
            {
                Ok(secret) => {
                    drop(Zeroizing::new(secret));
                    println!("configured");
                    Ok(())
                }
                Err(keyring::Error::NoEntry) => {
                    println!("missing");
                    Ok(())
                }
                Err(e) => Err(format!("checking credential {reference}: {e}")),
            }
        }
    }
}

fn validate_reference(reference: &str) -> Result<(), String> {
    let segments: Vec<_> = reference.split('/').collect();
    let shape_is_valid = match segments.as_slice() {
        ["connector", _, kind, _] => {
            matches!(
                *kind,
                "mail" | "calendar" | "contacts" | "messenger" | "files" | "documents" | "wiki"
            )
        }
        ["oauth", "google", secret] => {
            *secret == "client-secret"
                || secret.strip_prefix("client-secret.").is_some_and(|revision| {
                    !revision.is_empty()
                        && revision.chars().all(|character| character.is_ascii_alphanumeric())
                })
        }
        ["oauth", "m365", "password", _] => true,
        ["totp", _] => true,
        _ => false,
    };
    if reference.len() <= 512
        && shape_is_valid
        && segments[1..].iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment.chars().all(|c| c.is_ascii_alphanumeric() || "@+._-".contains(c))
        })
    {
        Ok(())
    } else {
        Err("invalid Eule credential reference".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_reference;

    #[test]
    fn accepts_scoped_connector_references_only() {
        assert!(validate_reference("connector/personal/mail/icloud").is_ok());
        assert!(validate_reference("connector/work/mail/user@example.com").is_ok());
        assert!(validate_reference("connector/work/wiki/intranet.a1b2").is_ok());
        assert!(validate_reference("connector/work/unknown/intranet").is_err());
        assert!(validate_reference("oauth/google/client-secret.a1b2").is_ok());
        assert!(validate_reference("oauth/google/client-secretevil").is_err());
        assert!(validate_reference("oauth/m365/password/a1b2.c3d4").is_ok());
        assert!(validate_reference("oauth/m365/password").is_err());
        assert!(validate_reference("totp/a1b2").is_ok());
        assert!(validate_reference("other-app/secret").is_err());
        assert!(validate_reference("connector/../../escape").is_err());
    }
}
