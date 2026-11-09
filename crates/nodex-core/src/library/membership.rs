//! Library-owned Space membership, enrollment and credential persistence.
//! Random 256-bit bearer secrets appear only in one-time responses.
use crate::infrastructure::module_receipts::module_storage_name;
use crate::infrastructure::{
    sqlite::{StoreError, StoreErrorCode, with_immediate_transaction},
    store::SqliteStoreKernel,
    writer::{StoreReaders, StoreWriter},
};
use nodex_core_contracts::{ModuleName, RemotePrincipal, library::MemberRole, team::*};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[cfg(test)]
#[path = "membership_tests.rs"]
mod tests;

pub struct LibraryMembership {
    readers: StoreReaders,
    writer: StoreWriter,
    space: String,
    principal: Option<RemotePrincipal>,
}
fn unauthorized() -> StoreError {
    StoreError::new(
        StoreErrorCode::Unauthorized,
        "Space credential is invalid, expired or revoked",
        false,
    )
}
fn invalid(message: &str) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
/// A Space without a chosen name reads as what it is: Personal while its one Owner keeps it on
/// their own desktop, Team Space once it is shared or hosted. Every surface reads this name.
const SPACE_NAME_SQL: &str = "SELECT COALESCE(name, CASE WHEN space_kind='personal' AND hosted=0 \
     THEN 'Personal' ELSE 'Team Space' END) FROM libraries WHERE id=?1";
/// How often a live connection refreshes its Device's last-seen time.
pub const DEVICE_SEEN_INTERVAL_SECONDS: i64 = 60;
fn secret() -> Result<String, StoreError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| {
        StoreError::new(
            StoreErrorCode::Internal,
            "Secure random source unavailable",
            false,
        )
    })?;
    Ok(hex::encode(bytes))
}
fn hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}
fn role(value: &str) -> MemberRole {
    if value == "owner" {
        MemberRole::Owner
    } else {
        MemberRole::Member
    }
}
fn role_name(value: MemberRole) -> &'static str {
    if value == MemberRole::Owner {
        "owner"
    } else {
        "member"
    }
}
fn label(value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() || value.chars().count() > 256 {
        return Err(invalid("Name must contain 1 to 256 characters"));
    }
    Ok(())
}
/// A Member's stored name is how others recognize them. "You" is only ever how Nodex shows a
/// reader their own Member, so no stored name may claim it.
fn member_name(value: &str) -> Result<String, StoreError> {
    let name = value.trim();
    label(name)?;
    if name.chars().any(char::is_control) {
        return Err(invalid("A name cannot contain control characters"));
    }
    if name.eq_ignore_ascii_case("you") {
        return Err(invalid(
            "Choose a name others will recognize; Nodex shows each person their own actions as You",
        ));
    }
    Ok(name.to_owned())
}
/// The local Owner's name until they choose one: how their OS account names its person.
pub fn default_owner_name() -> String {
    nodex_platform::process::account_display_name()
        .map(|name| {
            name.chars()
                .filter(|c| !c.is_control())
                .take(256)
                .collect::<String>()
        })
        .and_then(|name| member_name(&name).ok())
        .unwrap_or_else(|| "Owner".to_owned())
}
/// Relay handles are base64url; keys are exactly 32 canonical base64url bytes.
fn validate_push(registration: &PushRegistration) -> Result<(), StoreError> {
    use base64::prelude::{BASE64_URL_SAFE_NO_PAD, Engine as _};
    let url_safe = |value: &str| {
        value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if registration.handle.is_empty()
        || registration.handle.len() > 1024
        || !url_safe(&registration.handle)
    {
        return Err(invalid("Notification handle is invalid"));
    }
    if registration.key.len() != 43
        || !url_safe(&registration.key)
        || BASE64_URL_SAFE_NO_PAD
            .decode(&registration.key)
            .map_or(true, |key| key.len() != 32)
    {
        return Err(invalid("Notification key is invalid"));
    }
    Ok(())
}
fn verified_device(
    c: &rusqlite::Connection,
    space: &str,
    credential_hash: &str,
) -> Result<AuthenticatedDevice, StoreError> {
    let record=c.query_row("SELECT d.id,d.library_id,d.member_id,m.role,d.credential_hash FROM member_devices d JOIN members m ON m.id=d.member_id AND m.library_id=d.library_id WHERE d.credential_hash=?1 AND d.library_id=?2 AND d.revoked_at IS NULL AND m.lifecycle='active'",params![credential_hash,space],|r|Ok((AuthenticatedDevice{device_id:r.get(0)?,space_id:r.get(1)?,member_id:r.get(2)?,role:role(&r.get::<_,String>(3)?)},r.get::<_,String>(4)?))).optional()?;
    let Some((device, stored)) = record else {
        return Err(unauthorized());
    };
    if !bool::from(stored.as_bytes().ct_eq(credential_hash.as_bytes())) {
        return Err(unauthorized());
    }
    Ok(device)
}

fn bind_run_requester(
    c: &rusqlite::Connection,
    session: &str,
    run: Option<&str>,
    message: Option<&str>,
) -> Result<(), StoreError> {
    let Some(run) = run else { return Ok(()) };
    let Some(message) = message else {
        c.execute("INSERT OR IGNORE INTO session_run_members(session_id,run_id,member_id) SELECT ?1,?2,member_id FROM session_requesting_members WHERE session_id=?1 ORDER BY accepted_at DESC,message_id DESC LIMIT 1", params![session,run])?;
        return Ok(());
    };
    // An Automation's message speaks for its Owner's standing grant, whichever host dispatches it.
    let member = match crate::automation::firing::message_requester(c, session, message)? {
        Some(owner) => Some(owner),
        None => c.query_row("SELECT member_id FROM session_requesting_members WHERE session_id=?1 AND message_id=?2", params![session,message], |r| r.get(0)).optional()?,
    };
    let Some(member) = member else {
        return Err(StoreError::new(
            StoreErrorCode::MissingDependencies,
            "The Runtime input message is awaiting Member acceptance evidence",
            true,
        ));
    };
    // Exact Runtime input refines an observation's provisional latest-message capture, and names
    // the message, so Core can tell whether another Member has replied after it.
    c.execute("INSERT INTO session_run_members(session_id,run_id,member_id,message_id) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id,run_id) DO UPDATE SET member_id=excluded.member_id,message_id=excluded.message_id",params![session,run,member,message])?;
    Ok(())
}

impl LibraryMembership {
    /// The execution owner verifies the Run; Core freezes its requesting Member
    /// before issuing a credential, even if the first observation has not arrived.
    pub fn bind_agent_attribution(
        &self,
        session: &str,
        run: Option<&str>,
        message: Option<&str>,
        backend: nodex_core_contracts::agent::AgentBackendKind,
    ) -> Result<(), StoreError> {
        let session = session.to_owned();
        let run = run.map(str::to_owned);
        let message = message.map(str::to_owned);
        if message.is_some() && run.is_none() {
            return Err(invalid("Message attribution requires its Run"));
        }
        let space = self.space.clone();
        let label = match backend {
            nodex_core_contracts::agent::AgentBackendKind::Codex => "Codex",
            nodex_core_contracts::agent::AgentBackendKind::Claude => "Claude",
            nodex_core_contracts::agent::AgentBackendKind::OpenCode => "OpenCode",
            nodex_core_contracts::agent::AgentBackendKind::Acp => "Agent",
        };
        self.writer.clone().call(move |c| with_immediate_transaction(c, |c| {
            bind_run_requester(c, &session, run.as_deref(), message.as_deref())?;
            crate::infrastructure::actors::for_session(c, &space, &session, run.clone())?;
            c.execute("INSERT INTO agent_actor_labels(session_id,run_key,label) VALUES(?1,?2,?3) ON CONFLICT(session_id,run_key) DO UPDATE SET label=excluded.label", params![session,run.as_deref().unwrap_or_default(),label])?;
            Ok(())
        }))
    }
    pub fn actor(
        &self,
        adapter: &nodex_core_contracts::AdapterKind,
        principal: Option<&RemotePrincipal>,
        attribution: Option<&nodex_core_contracts::BoundAgentAttribution>,
    ) -> Result<nodex_core_contracts::Actor, StoreError> {
        self.readers.read_default(|c| {
            crate::infrastructure::actors::derive(c, &self.space, adapter, principal, attribution)
        })
    }
    pub fn new(store: &SqliteStoreKernel, space: String) -> Self {
        Self {
            readers: store.readers(),
            writer: store.writer(),
            space,
            principal: None,
        }
    }
    /// Only the authenticated adapter may supply this principal.
    pub fn for_principal(&self, principal: Option<RemotePrincipal>) -> Self {
        Self {
            readers: self.readers.clone(),
            writer: self.writer.clone(),
            space: self.space.clone(),
            principal,
        }
    }
    fn caller(
        &self,
        c: &rusqlite::Connection,
        owner_only: bool,
    ) -> Result<(String, MemberRole), StoreError> {
        if let Some(p) = &self.principal {
            crate::infrastructure::member_admission::require_principal(c, &self.space, p)?;
        }
        let member = match &self.principal {
            Some(p) => p.member_id.clone(),
            None => crate::infrastructure::actors::local_member(c, &self.space)?,
        };
        let current: String = c.query_row(
            "SELECT role FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active'",
            params![member, self.space],
            |r| r.get(0),
        )?;
        let current = role(&current);
        if owner_only && current != MemberRole::Owner {
            return Err(StoreError::new(
                StoreErrorCode::Unauthorized,
                "Space Owner authority is required",
                false,
            ));
        }
        Ok((member, current))
    }
    /// Seal administrative changes with the same typed Actor evidence as content writes.
    fn audit(
        &self,
        c: &rusqlite::Connection,
        member: &str,
        operation: &str,
    ) -> Result<(), StoreError> {
        use crate::infrastructure::{
            durable_mutation::{self, OperationIdentity, ReceiptMetadata},
            local_commit,
        };
        use nodex_core_contracts::{
            Actor, AdapterKind, BoundModuleContext, LibraryId, ProfileId,
            administration::{StoreAdministrationEvent, StoreAdministrationEventKind},
        };
        let profile: String = c.query_row(
            "SELECT profile_id FROM libraries WHERE id=?1",
            [&self.space],
            |r| r.get(0),
        )?;
        let epoch: String = c.query_row(
            "SELECT store_epoch FROM block_store_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let context = BoundModuleContext {
            actor: Actor::Member {
                member_id: member.to_owned(),
            },
            authorizing_member_id: None,
            profile_id: ProfileId(profile),
            library_id: LibraryId(self.space.clone()),
            project_id: None,
            connection_id: "space-administration".into(),
            adapter: if self.principal.is_some() {
                AdapterKind::RemoteMember
            } else {
                AdapterKind::NativeCli
            },
            principal: self.principal.clone(),
            editor_history_owner: None,
            agent_attribution: None,
        };
        let id = secret()?;
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let digest = hash(operation);
        let _result = durable_mutation::run(
            c,
            OperationIdentity {
                module: ModuleName::StoreAdministration,
                module_name: "store_administration",
                operation_id: &id,
                intent_hash: &digest,
                store_epoch: &epoch,
                committed_at: &at,
                context: &context,
            },
            |scope| {
                local_commit::record_administration_effect(
                    c,
                    scope.evidence(),
                    &self.space,
                    &StoreAdministrationEvent {
                        kind: StoreAdministrationEventKind::StoreAdministrationChanged,
                        operation: operation.into(),
                        backup_ids: vec![],
                        readiness_changed: false,
                    },
                )?;
                Ok(scope.seal(
                    serde_json::json!({"changed":true}),
                    ReceiptMetadata {
                        operation_kind: operation,
                        event_sequence: None,
                        committed_at: &at,
                    },
                ))
            },
        )?;
        Ok(())
    }
    pub fn require_owner(&self) -> Result<String, StoreError> {
        self.readers
            .read_default(|c| self.caller(c, true).map(|(id, _)| id))
    }
    pub fn kind(&self) -> Result<SpaceKind, StoreError> {
        self.readers.read_default(|c| {
            let kind: String = c.query_row(
                "SELECT space_kind FROM libraries WHERE id=?1",
                [&self.space],
                |r| r.get(0),
            )?;
            match kind.as_str() {
                "personal" => Ok(SpaceKind::Personal),
                "team" => Ok(SpaceKind::Team),
                _ => Err(StoreError::new(
                    StoreErrorCode::Internal,
                    "Invalid Space kind",
                    false,
                )),
            }
        })
    }
    pub fn name(&self) -> Result<String, StoreError> {
        self.readers
            .read_default(|c| Ok(c.query_row(SPACE_NAME_SQL, [&self.space], |r| r.get(0))?))
    }
    /// Space administration is local Owner authority, independent of an Agent's content scope.
    pub fn rename(&self, request: RenameSpaceRequest) -> Result<SpaceName, StoreError> {
        let name = request.name.trim().to_owned();
        label(&name)?;
        if name.chars().any(char::is_control) {
            return Err(invalid("A Space name cannot contain control characters"));
        }
        let space = self.space.clone();
        let this = self.for_principal(self.principal.clone());
        self.writer.clone().call(move |c| {
            with_immediate_transaction(c, |c| {
                let (member, _) = this.caller(c, true)?;
                c.execute(
                    "UPDATE libraries SET name=?2,updated_at=?3 WHERE id=?1",
                    params![
                        space,
                        name,
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    ],
                )?;
                this.audit(c, &member, "rename_space")?;
                Ok(SpaceName {
                    space_id: space,
                    name,
                })
            })
        })
    }
    /// Each Member names themselves; the local Owner does so through local administration.
    pub fn rename_member(
        &self,
        request: RenameMemberRequest,
    ) -> Result<nodex_core_contracts::library::Member, StoreError> {
        let name = member_name(&request.name)?;
        let this = self.for_principal(self.principal.clone());
        self.writer.clone().call(move |c| {
            with_immediate_transaction(c, |c| {
                let (member, _) = this.caller(c, false)?;
                c.execute(
                    "UPDATE members SET display_name=?2,revision=revision+1 \
                     WHERE id=?1 AND library_id=?3 AND display_name<>?2",
                    params![member, name, this.space],
                )?;
                this.audit(c, &member, "rename_member")?;
                super::members::list(c, &this.space)?
                    .into_iter()
                    .find(|named| named.id == member)
                    .ok_or_else(|| invalid("The Member is unavailable"))
            })
        })
    }
    /// Headless hosting controls repository execution semantics independently of team membership.
    pub fn prepare_hosting(&self) -> Result<(), StoreError> {
        let this = self.for_principal(None);
        self.writer.call(move |c| {
            with_immediate_transaction(c, |c| {
                let (owner, _) = this.caller(c, true)?;
                c.execute("UPDATE libraries SET hosted=1 WHERE id=?1", [&this.space])?;
                this.audit(c, &owner, "prepare_hosting")
            })
        })
    }
    pub fn invite(
        &self,
        request: InviteRequest,
        info: ListenerInfo,
    ) -> Result<InviteResponse, StoreError> {
        let space = self.space.clone();
        let code = secret()?;
        let code_hash = hash(&code);
        let id = secret()?;
        let expires_at = now() + 86400;
        let this = self.for_principal(self.principal.clone());
        self.writer.clone().call(move |c| with_immediate_transaction(c, |c| { let (owner,_) = this.caller(c, true)?; c.execute("DELETE FROM space_invites WHERE (device_link=0 AND (expires_at<=?1 OR redeemed_at IS NOT NULL)) OR (device_link=1 AND expires_at<=?1 AND created_at<=?2)",params![now(),now()-3600])?;
   let count:i64=c.query_row("SELECT count(*) FROM space_invites",[],|r|r.get(0))?;if count>=1024 {return Err(invalid("Invite capacity reached"));}
   if let Some(member)=&request.member_id {
    let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active' AND role=?3)",params![member,space,role_name(request.role)],|r|r.get(0))?;
    if !valid {return Err(invalid("Invite requires an active Member with the same role"));}
   }
   c.execute("INSERT INTO space_invites(id,library_id,code_hash,role,expires_at,created_by,member_id) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,space,code_hash,role_name(request.role),expires_at,owner,request.member_id])?;this.audit(c, &owner, "invite_member")?;Ok(()) }))?;
        Ok(InviteResponse {
            url: info.routes.first().cloned().unwrap_or(info.url),
            fingerprint: info.fingerprint,
            code,
            expires_at,
        })
    }
    pub fn enroll(&self, request: EnrollmentRequest) -> Result<EnrollmentResponse, StoreError> {
        label(&request.device_label)?;
        label(&request.display_name)?;
        // A new Member's name is how others will recognize them; another Device of an
        // existing Member keeps that Member's name.
        let display_name = member_name(&request.display_name);
        if request.code.len() != 64 {
            return Err(unauthorized());
        }
        let space = self.space.clone();
        let code_hash = hash(&request.code);
        let member_id = secret()?;
        let device_id = secret()?;
        let credential = secret()?;
        let credential_hash = hash(&credential);
        let this = self.for_principal(None);
        self.writer.clone().call(move |c| with_immediate_transaction(c,|c| {
   let invite:Option<(String,String,Option<String>,String)>=c.query_row("SELECT id,role,member_id,code_hash FROM space_invites WHERE library_id=?1 AND code_hash=?2 AND redeemed_at IS NULL AND expires_at>?3",params![space,code_hash,now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
   let Some((invite_id,role,existing_member,stored_hash))=invite else{return Err(unauthorized())};
   if !bool::from(stored_hash.as_bytes().ct_eq(code_hash.as_bytes())) {return Err(unauthorized());}
   let count:i64=c.query_row("SELECT count(*) FROM members WHERE library_id=?1",[&space],|r|r.get(0))?;if count>=1024 && existing_member.is_none() {return Err(invalid("Member capacity reached"));}
   c.execute("UPDATE space_invites SET redeemed_at=?2 WHERE id=?1",params![invite_id,now()])?;
   let member_id=match existing_member {
    Some(id)=>{let active:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active' AND role=?3)",params![id,space,role],|r|r.get(0))?;if !active{return Err(unauthorized());}id},
    None=>{let display_name=display_name.clone()?;c.execute("UPDATE libraries SET space_kind='team' WHERE id=?1",[&space])?;c.execute("INSERT INTO members(id,library_id,display_name,lifecycle,role) VALUES(?1,?2,?3,'active',?4)",params![member_id,space,display_name,role])?;member_id.clone()}
   };
   let device_count:i64=c.query_row("SELECT count(*) FROM member_devices WHERE member_id=?1 AND revoked_at IS NULL",[&member_id],|r|r.get(0))?;if device_count>=16{return Err(invalid("Member device capacity reached"));}
   let total_devices:i64=c.query_row("SELECT count(*) FROM member_devices",[],|r|r.get(0))?;if total_devices>=16384{return Err(invalid("Space device capacity reached"));}
   c.execute("INSERT INTO member_devices(id,library_id,member_id,label,credential_hash,created_at,last_seen,form_factor) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)",params![device_id,space,member_id,request.device_label.trim(),credential_hash,now(), match request.form_factor { DeviceFormFactor::Desktop => "desktop", DeviceFormFactor::Phone => "phone" }])?;
   this.audit(c, &member_id, "enroll_device")?;
   let space_name=c.query_row(SPACE_NAME_SQL,[&space],|r|r.get(0))?;
   Ok(EnrollmentResponse{space_id:space.clone(),space_name,member_id:member_id.clone(),device_id:device_id.clone(),device_credential:credential.clone()})
  }))
    }
    pub fn authenticate_device(&self, credential: &str) -> Result<AuthenticatedDevice, StoreError> {
        if credential.len() != 64 {
            return Err(unauthorized());
        }
        let credential_hash = hash(credential);
        self.readers
            .read_default(|c| verified_device(c, &self.space, &credential_hash))
    }
    pub fn session(&self, request: SessionRequest) -> Result<SessionResponse, StoreError> {
        if request.device_credential.len() != 64 {
            return Err(unauthorized());
        }
        let space = self.space.clone();
        let credential_hash = hash(&request.device_credential);
        let token = secret()?;
        let token_hash = hash(&token);
        let id = secret()?;
        let expires_at = now() + 3600;
        self.writer.clone().call(move |c| with_immediate_transaction(c,|c| {
   let AuthenticatedDevice{device_id,space_id,member_id,role}=verified_device(c,&space,&credential_hash)?;
   c.execute("DELETE FROM member_sessions WHERE expires_at<=?1",[now()])?;
   let count:i64=c.query_row("SELECT count(*) FROM member_sessions WHERE device_id=?1",[&device_id],|r|r.get(0))?;
   if count>=16 {
    c.execute("DELETE FROM member_sessions WHERE id IN (SELECT id FROM member_sessions WHERE device_id=?1 ORDER BY created_at,id LIMIT ?2)",params![device_id,count-15])?;
   }
   c.execute("INSERT INTO member_sessions(id,device_id,token_hash,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)",params![id,device_id,token_hash,now(),expires_at])?;
   c.execute("UPDATE member_devices SET last_seen=?2 WHERE id=?1",params![device_id,now()])?;
   Ok(SessionResponse{session_token:token.clone(),expires_at,principal:RemotePrincipal{space_id,member_id,device_id,session_id:id.clone(),role}})
  }))
    }
    pub fn authenticate(&self, token: &str) -> Result<RemotePrincipal, StoreError> {
        if token.len() != 64 {
            return Err(unauthorized());
        }
        let space = self.space.clone();
        let token_hash = hash(token);
        self.readers.read_default(move |c| {
   let value=c.query_row("SELECT d.library_id,d.member_id,d.id,s.id,m.role,s.token_hash FROM member_sessions s JOIN member_devices d ON d.id=s.device_id JOIN members m ON m.id=d.member_id AND m.library_id=d.library_id WHERE s.token_hash=?1 AND s.expires_at>?2 AND d.library_id=?3 AND d.revoked_at IS NULL AND m.lifecycle='active'",params![token_hash,now(),space],|r| Ok((RemotePrincipal{space_id:r.get(0)?,member_id:r.get(1)?,device_id:r.get(2)?,session_id:r.get(3)?,role:role(&r.get::<_,String>(4)?)},r.get::<_,String>(5)?))).optional()?;
   let Some((principal,stored))=value else{return Err(unauthorized())};if !bool::from(stored.as_bytes().ct_eq(token_hash.as_bytes())) {return Err(unauthorized());}Ok(principal)
  })
    }
    pub fn active(&self, principal: &RemotePrincipal) -> bool {
        if principal.space_id != self.space {
            return false;
        }
        self.readers.read_default(|c| Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM member_sessions s JOIN member_devices d ON d.id=s.device_id JOIN members m ON m.id=d.member_id WHERE s.id=?1 AND s.expires_at>?2 AND d.revoked_at IS NULL AND m.lifecycle='active' AND m.role=?3 AND d.member_id=?4 AND d.id=?5 AND d.library_id=?6)",params![principal.session_id,now(),role_name(principal.role),principal.member_id,principal.device_id,principal.space_id],|r|r.get::<_,bool>(0))?)).unwrap_or(false)
    }
    /// A Device with a live authenticated connection is seen now. Its time advances at most
    /// once a minute, however many connections or streams the Device keeps open.
    pub fn mark_seen(&self, principal: &RemotePrincipal) -> Result<(), StoreError> {
        if principal.space_id != self.space {
            return Ok(());
        }
        let (device, space) = (principal.device_id.clone(), self.space.clone());
        self.writer.call(move |c| {
            c.execute(
                "UPDATE member_devices SET last_seen=?3 WHERE id=?1 AND library_id=?2 \
                 AND revoked_at IS NULL AND last_seen<=?3-?4",
                params![device, space, now(), DEVICE_SEEN_INTERVAL_SECONDS],
            )?;
            Ok(())
        })
    }
    /// A receipt remains private to its initiating Member across session renewal.
    pub fn owns_operation(
        &self,
        principal: &RemotePrincipal,
        module: ModuleName,
        operation_id: &str,
    ) -> Result<bool, StoreError> {
        if principal.space_id != self.space {
            return Ok(false);
        }
        self.readers.read_default(|connection| {
            Ok(connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM remote_operation_members
                 WHERE module_name=?1 AND operation_id=?2 AND member_id=?3)",
                params![
                    module_storage_name(module),
                    operation_id,
                    principal.member_id
                ],
                |row| row.get(0),
            )?)
        })
    }

    pub fn members(&self) -> Result<Vec<nodex_core_contracts::library::Member>, StoreError> {
        self.readers.read_default(|c| {
            self.caller(c, true)?;
            super::members::list(c, &self.space)
        })
    }
    pub fn devices(&self) -> Result<Vec<MemberDevice>, StoreError> {
        self.readers.read_default(|c| {
            let (member, role) = self.caller(c, false)?;
            Ok(c.prepare("SELECT d.id,d.member_id,d.label,d.created_at,d.last_seen,d.revoked_at,d.form_factor,d.library_id,EXISTS(SELECT 1 FROM member_device_push_registrations r WHERE r.device_id=d.id) FROM member_devices d WHERE d.library_id=?1 AND (?2='owner' OR d.member_id=?3) ORDER BY d.created_at,d.id LIMIT 16384")?.query_map(params![self.space,role_name(role),member],|r|Ok(MemberDevice{id:r.get(0)?,member_id:r.get(1)?,label:r.get(2)?,created_at:r.get(3)?,last_seen:r.get(4)?,revoked_at:r.get(5)?,form_factor:if r.get::<_,String>(6)?=="phone" {DeviceFormFactor::Phone} else {DeviceFormFactor::Desktop},space_id:r.get(7)?,notifications_enabled:r.get(8)?}))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
    pub fn revoke(&self, id: String) -> Result<(), StoreError> {
        let this = self.for_principal(self.principal.clone());
        self.writer.call(move |c| with_immediate_transaction(c, |c| {
            let (member, role) = this.caller(c, false)?;
            let allowed: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM member_devices WHERE id=?1 AND library_id=?2 AND (?3='owner' OR member_id=?4))",params![id,this.space,role_name(role),member],|r|r.get(0))?;
            if !allowed { return Err(StoreError::new(StoreErrorCode::Unauthorized,"Device belongs to another Member",false)); }
            this.audit(c, &member, "revoke_device")?;
            // Retire the Member's pending Device-link codes so a withdrawn Device cannot
            // regain access by redeeming an offer it minted before revocation.
            c.execute("UPDATE space_invites SET redeemed_at=COALESCE(redeemed_at,?2) WHERE device_link=1 AND redeemed_at IS NULL AND member_id=(SELECT member_id FROM member_devices WHERE id=?1 AND library_id=?3)",params![id,now(),this.space])?;
            c.execute("UPDATE member_devices SET revoked_at=COALESCE(revoked_at,?2) WHERE id=?1", params![id,now()])?;
            c.execute("DELETE FROM member_device_push_registrations WHERE device_id=?1", [&id])?;
            Ok(())
        }))
    }
    pub fn remove(&self, id: String) -> Result<(), StoreError> {
        let this = self.for_principal(self.principal.clone());
        self.writer.call(move |c| with_immediate_transaction(c, |c| {
            let (owner,_) = this.caller(c, true)?;
            if owner == id { return Err(invalid("An Owner cannot remove themselves")); }
            let active: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM members WHERE id=?1 AND library_id=?2 AND lifecycle='active')",params![id,this.space],|r|r.get(0))?;
            if !active { return Err(invalid("Member is not active in this Space")); }
            c.execute("UPDATE members SET lifecycle='removed',revision=revision+1 WHERE id=?1 AND library_id=?2",params![id,this.space])?;
            c.execute("UPDATE member_devices SET revoked_at=COALESCE(revoked_at,?2) WHERE member_id=?1 AND library_id=?3",params![id,now(),this.space])?;
            c.execute("DELETE FROM member_device_push_registrations WHERE device_id IN (SELECT id FROM member_devices WHERE member_id=?1 AND library_id=?2)",params![id,this.space])?;
            this.audit(c, &owner, "remove_member")?;
            Ok(())
        }))
    }
    /// The verified phone's own Device registers or withdraws where it hears about chats. One phone
    /// holds one registration per Member, so its newest Device replaces any older one's.
    pub fn set_push_registration(
        &self,
        registration: Option<PushRegistration>,
    ) -> Result<(), StoreError> {
        let Some(principal) = self.principal.clone() else {
            return Err(unauthorized());
        };
        let registration =
            registration.filter(|r| r.preferences.needs_you || r.preferences.finished);
        if let Some(registration) = &registration {
            validate_push(registration)?;
        }
        let this = self.for_principal(Some(principal.clone()));
        self.writer.call(move |c| {
            with_immediate_transaction(c, |c| {
                this.caller(c, false)?;
                let device = &principal.device_id;
                let Some(registration) = registration else {
                    c.execute("DELETE FROM member_device_push_registrations WHERE device_id=?1", [device])?;
                    return Ok(());
                };
                c.execute("DELETE FROM member_device_push_registrations WHERE handle=?1 AND device_id<>?2 AND device_id IN (SELECT id FROM member_devices WHERE member_id=?3 AND library_id=?4)",params![registration.handle,device,principal.member_id,this.space])?;
                c.execute("INSERT INTO member_device_push_registrations(device_id,handle,push_key,needs_you,finished,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(device_id) DO UPDATE SET handle=excluded.handle,push_key=excluded.push_key,needs_you=excluded.needs_you,finished=excluded.finished,updated_at=excluded.updated_at",params![device,registration.handle,registration.key,registration.preferences.needs_you,registration.preferences.finished,now()])?;
                Ok(())
            })
        })
    }
    /// Registrations of a current Member's current Devices, for the local Host's delivery only.
    pub fn push_recipients(&self, member: &str) -> Result<Vec<PhonePushRecipient>, StoreError> {
        self.readers.read_default(|c| {
            Ok(c.prepare("SELECT r.device_id,d.member_id,r.handle,r.push_key,r.needs_you,r.finished FROM member_device_push_registrations r JOIN member_devices d ON d.id=r.device_id JOIN members m ON m.id=d.member_id AND m.library_id=d.library_id WHERE d.library_id=?1 AND d.member_id=?2 AND d.revoked_at IS NULL AND m.lifecycle='active' ORDER BY r.device_id LIMIT 16")?.query_map(params![self.space,member],|r|Ok(PhonePushRecipient{device_id:r.get(0)?,member_id:r.get(1)?,registration:PushRegistration{handle:r.get(2)?,key:r.get(3)?,preferences:PushPreferences{needs_you:r.get(4)?,finished:r.get(5)?}}}))?.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }
    /// The relay no longer reaches this handle. A phone that has since registered again keeps it.
    pub fn forget_push_registration(
        &self,
        device: String,
        handle: String,
    ) -> Result<bool, StoreError> {
        let space = self.space.clone();
        self.writer.call(move |c| {
            Ok(c.execute("DELETE FROM member_device_push_registrations WHERE device_id=?1 AND handle=?2 AND device_id IN (SELECT id FROM member_devices WHERE library_id=?3)",params![device,handle,space])? > 0)
        })
    }
    pub fn link_device(&self, info: ListenerInfo) -> Result<DeviceLinkOffer, StoreError> {
        let this = self.for_principal(self.principal.clone());
        let code = secret()?;
        let code_hash = hash(&code);
        let expires_at = now() + 300;
        let member_id = self.writer.call(move |c| with_immediate_transaction(c, |c| {
            let (member,role) = this.caller(c, false)?;
            let (recent, oldest): (i64, Option<i64>) = c.query_row("SELECT count(*),min(created_at) FROM space_invites WHERE library_id=?1 AND created_by=?2 AND device_link=1 AND created_at>?3",params![this.space,member,now()-3600],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if recent >= 6 {
                let milliseconds = oldest.unwrap_or_else(now).saturating_add(3600).saturating_sub(now()).max(1) as u64 * 1000;
                return Err(StoreError::new(StoreErrorCode::ResourceExhausted,"Device linking is limited to six offers per hour",true)
                    .with_recovery(nodex_core_contracts::CoreErrorRecovery::RetryAfter { budget: RemoteBudget::MemberDeviceLinks, milliseconds }));
            }
            let reserved: i64 = c.query_row("SELECT (SELECT count(*) FROM member_devices WHERE library_id=?1 AND member_id=?2 AND revoked_at IS NULL)+(SELECT count(*) FROM space_invites WHERE library_id=?1 AND member_id=?2 AND redeemed_at IS NULL AND expires_at>?3)",params![this.space,member,now()],|r|r.get(0))?;
            if reserved >= 16 { return Err(invalid("Member device capacity reached")); }
            c.execute("DELETE FROM space_invites WHERE expires_at<=?1 AND created_at<=?2",params![now(),now()-3600])?;
            let count:i64=c.query_row("SELECT count(*) FROM space_invites",[],|r|r.get(0))?;
            if count>=1024 {return Err(invalid("Invite capacity reached"));}
            c.execute("INSERT INTO space_invites(id,library_id,code_hash,role,member_id,expires_at,created_by,device_link,created_at) VALUES(?1,?2,?3,?4,?5,?6,?5,1,?7)",params![secret()?,this.space,code_hash,role_name(role),member,expires_at,now()])?;
            this.audit(c, &member, "link_device")?;
            Ok(member)
        }))?;
        Ok(DeviceLinkOffer {
            space_id: self.space.clone(),
            space_name: self.name()?,
            member_id,
            fingerprint: info.fingerprint,
            routes: info.routes,
            code,
            expires_at,
        })
    }
}
