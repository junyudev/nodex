use super::*;
use nodex_platform::test_support::{TempDir, tempdir};

struct Space {
    membership: LibraryMembership,
    store: SqliteStoreKernel,
    _directory: TempDir,
}

impl Space {
    fn new() -> Self {
        let directory = tempdir().unwrap();
        let store = SqliteStoreKernel::open_test(directory.path()).unwrap();
        store
            .writer()
            .call(|connection| {
                connection.execute_batch(
                    "INSERT INTO block_store_metadata(id,store_epoch,created_at,updated_at) VALUES(1,'test-epoch',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
                 INSERT INTO profiles(id,created_at,updated_at) VALUES('profile',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
                 INSERT INTO libraries(id,profile_id,created_at,updated_at)
                 VALUES('space','profile',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
                )?;
                Ok(())
            })
            .unwrap();
        let membership = LibraryMembership::new(&store, "space".into());
        Self {
            membership,
            store,
            _directory: directory,
        }
    }

    fn invite(&self) -> InviteResponse {
        self.membership
            .invite(
                InviteRequest {
                    role: MemberRole::Member,
                    member_id: None,
                },
                ListenerInfo {
                    peer_policy: Default::default(),
                    routes: vec![],
                    url: "https://localhost".into(),
                    fingerprint: "test".into(),
                },
            )
            .unwrap()
    }
}

fn enrollment(code: String) -> EnrollmentRequest {
    EnrollmentRequest {
        form_factor: Default::default(),
        code,
        device_label: "Laptop".into(),
        display_name: "Bob".into(),
    }
}

#[test]
fn enrollment_rolls_back_member_and_invite_when_device_persistence_fails() {
    let space = Space::new();
    let request = enrollment(space.invite().code);
    // Inject a storage failure after Member insertion to prove the transaction boundary.
    space
        .store
        .writer()
        .call(|connection| {
            connection.execute_batch(
                "CREATE TEMP TRIGGER reject_device BEFORE INSERT ON member_devices
             BEGIN SELECT RAISE(ABORT,'Device write failed'); END;",
            )?;
            Ok(())
        })
        .unwrap();
    assert!(space.membership.enroll(request.clone()).is_err());
    assert!(space.membership.devices().unwrap().is_empty());
    space
        .store
        .writer()
        .call(|connection| {
            assert_eq!(
                connection.query_row("SELECT count(*) FROM members", [], |row| row
                    .get::<_, i64>(0))?,
                1,
                "The new Member must roll back with the failed Device"
            );
            connection.execute_batch("DROP TRIGGER reject_device")?;
            Ok(())
        })
        .unwrap();

    space.membership.enroll(request.clone()).unwrap();
    assert_eq!(space.membership.devices().unwrap().len(), 1);
    assert!(
        matches!(space.membership.enroll(request), Err(error) if error.code == StoreErrorCode::Unauthorized)
    );
}

#[test]
fn session_issuance_rechecks_a_device_revoked_after_authentication() {
    let space = Space::new();
    let device = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    space
        .membership
        .authenticate_device(&device.device_credential)
        .unwrap();
    let request = SessionRequest {
        device_credential: device.device_credential,
    };
    let session = space.membership.session(request.clone()).unwrap();
    assert!(space.membership.active(&session.principal));

    space.membership.revoke(device.device_id).unwrap();
    assert!(!space.membership.active(&session.principal));
    assert!(
        space
            .membership
            .authenticate(&session.session_token)
            .is_err()
    );
    assert!(
        matches!(space.membership.session(request), Err(error) if error.code == StoreErrorCode::Unauthorized)
    );
}

#[test]
fn space_name_is_owner_controlled_and_enrollment_reads_its_current_value() {
    // An unchosen name reads as what the Space is, on every surface that shows it.
    let hosted = Space::new();
    assert_eq!(hosted.membership.name().unwrap(), "Personal");
    hosted.membership.prepare_hosting().unwrap();
    assert_eq!(hosted.membership.name().unwrap(), "Team Space");
    let space = Space::new();
    let shared = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    assert_eq!(shared.space_name, "Team Space");
    assert_eq!(space.membership.name().unwrap(), "Team Space");
    let named = space
        .membership
        .rename(RenameSpaceRequest {
            name: "  Platform  ".into(),
        })
        .unwrap();
    assert_eq!(named.name, "Platform");
    let device = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    assert_eq!(device.space_name, "Platform");
    for name in [" ".to_owned(), "x".repeat(257), "Two\nlines".to_owned()] {
        assert!(
            space
                .membership
                .rename(RenameSpaceRequest { name })
                .is_err()
        );
    }
    assert_eq!(space.membership.name().unwrap(), "Platform");
    space
        .membership
        .rename(RenameSpaceRequest {
            name: "Delivery".into(),
        })
        .unwrap();
    let Space {
        membership,
        store,
        _directory: directory,
    } = space;
    drop(membership);
    drop(store);
    let store = SqliteStoreKernel::open_test(directory.path()).unwrap();
    let membership = LibraryMembership::new(&store, "space".into());
    assert_eq!(membership.name().unwrap(), "Delivery");
    store.writer().call(|c| {
        c.execute("UPDATE members SET role='member' WHERE id IN (SELECT member_id FROM local_profile_members)", [])?;
        Ok(())
    }).unwrap();
    assert!(
        matches!(membership.rename(RenameSpaceRequest { name: "Forbidden".into() }), Err(e) if e.code == StoreErrorCode::Unauthorized)
    );
    assert_eq!(membership.name().unwrap(), "Delivery");
}

#[test]
fn agent_credentials_freeze_the_run_requester_before_observation() {
    use nodex_core_contracts::{
        Actor, AdapterKind, BoundAgentAttribution, agent::AgentBackendKind,
    };
    let space = Space::new();
    let bob = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    let alice = space
        .membership
        .enroll(EnrollmentRequest {
            form_factor: Default::default(),
            display_name: "Alice".into(),
            ..enrollment(space.invite().code)
        })
        .unwrap();
    let bob_id = bob.member_id.clone();
    space.store.writer().call(move |c| {
        c.execute("INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at) VALUES('chat','Work','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',1793491200000)", [])?;
        c.execute("INSERT INTO session_requesting_members VALUES('chat','message',?1,'2026-11-01T00:00:00Z')",[bob_id])?;
        Ok(())
    }).unwrap();
    space
        .membership
        .bind_agent_attribution(
            "chat",
            Some("run"),
            Some("message"),
            AgentBackendKind::Codex,
        )
        .unwrap();
    let alice_id = alice.member_id;
    space.store.writer().call(move |c| {
        c.execute("INSERT INTO session_requesting_members VALUES('chat','later',?1,'2026-11-02T00:00:00Z')",[alice_id])?;
        Ok(())
    }).unwrap();
    space
        .membership
        .bind_agent_attribution(
            "chat",
            Some("run"),
            Some("message"),
            AgentBackendKind::Codex,
        )
        .unwrap();
    assert_eq!(
        space
            .membership
            .actor(
                &AdapterKind::Agent,
                None,
                Some(&BoundAgentAttribution {
                    session_id: "chat".into(),
                    run_id: Some("run".into()),
                    backend: AgentBackendKind::Codex,
                })
            )
            .unwrap(),
        Actor::Agent {
            session_id: "chat".into(),
            run_id: Some("run".into()),
            on_behalf_of: bob.member_id.clone()
        }
    );
    // A queued Run starts after Alice's later message; its verified original
    // message still belongs to Bob, including after a provisional observation.
    space
        .membership
        .bind_agent_attribution("chat", Some("queued-run"), None, AgentBackendKind::Codex)
        .unwrap();
    space
        .membership
        .bind_agent_attribution(
            "chat",
            Some("queued-run"),
            Some("message"),
            AgentBackendKind::Codex,
        )
        .unwrap();
    assert!(
        matches!(space.membership.actor(&AdapterKind::Agent, None, Some(&BoundAgentAttribution {
        session_id: "chat".into(), run_id: Some("queued-run".into()), backend: AgentBackendKind::Codex,
    })).unwrap(), Actor::Agent {on_behalf_of,..} if on_behalf_of==bob.member_id)
    );
    assert!(
        matches!(space.membership.bind_agent_attribution("chat", Some("unknown-run"), Some("unknown-message"), AgentBackendKind::Codex), Err(e) if e.code==StoreErrorCode::MissingDependencies)
    );
    assert!(
        space
            .membership
            .bind_agent_attribution("missing", Some("run"), None, AgentBackendKind::Codex)
            .is_err()
    );
}

#[test]
fn automation_messages_act_for_their_grant_owner_before_the_run_binds_its_chat() {
    use nodex_core_contracts::{
        Actor, AdapterKind, BoundAgentAttribution, agent::AgentBackendKind,
    };
    let space = Space::new();
    let alice = space
        .membership
        .enroll(EnrollmentRequest {
            form_factor: Default::default(),
            display_name: "Alice".into(),
            ..enrollment(space.invite().code)
        })
        .unwrap();
    let bob = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    let (alice_id, bob_id) = (alice.member_id.clone(), bob.member_id.clone());
    space.store.writer().call(move |c| {
        c.execute("INSERT INTO project_sessions(id,no_thread_fallback_title,created_at,updated_at,activity_at) VALUES('chat','Report','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z',1793491200000)", [])?;
        // Bob spoke last in the chat; the Automation's standing grant belongs to Alice.
        c.execute("INSERT INTO session_requesting_members VALUES('chat','person',?1,'2026-11-01T00:00:00Z')",[&bob_id])?;
        c.execute("INSERT INTO automations(automation_id,owner_member_id,condition_text,timezone,jitter_salt,kind,status,name,created_at,updated_at) VALUES('report',?1,'Daily','UTC','salt','cron','ACTIVE','Report',1,1)",[&alice_id])?;
        for (dispatch, message, session) in [("dispatch:new", "automation:message:new", None), ("dispatch:bound", "automation:message:bound", Some("chat"))] {
            c.execute("INSERT INTO automation_decisions(dispatch_id,automation_id,status,mode,frozen_authority_json,first_scheduled_for_ms,last_scheduled_for_ms,hold_basis_json,created_at_ms,updated_at_ms) VALUES(?1,'report','admitted','run',json_object('owner_member_id',?2),1,1,'{}',1,1)",params![dispatch,&alice_id])?;
            c.execute("INSERT INTO automation_execution_runs(run_id,automation_id,session_id,status,created_at,updated_at,admission_hash,dispatch_id,message_id) VALUES(?1,'report',?2,'IN_PROGRESS',1,1,?3,?1,?4)",params![dispatch,session,"0".repeat(64),message])?;
        }
        // A Host may also record its own acceptance of the bound message; the grant still decides.
        c.execute("INSERT INTO session_requesting_members VALUES('chat','automation:message:bound',?1,'2026-11-02T00:00:00Z')",[&bob_id])?;
        Ok(())
    }).unwrap();
    let on_behalf_of = |run: &str| match space
        .membership
        .actor(
            &AdapterKind::Agent,
            None,
            Some(&BoundAgentAttribution {
                session_id: "chat".into(),
                run_id: Some(run.into()),
                backend: AgentBackendKind::Acp,
            }),
        )
        .unwrap()
    {
        Actor::Agent { on_behalf_of, .. } => on_behalf_of,
        actor => panic!("Expected an Agent actor, got {actor:?}"),
    };
    // A clock Run's new chat has no accepted message: its Turn is prepared before the Run binds.
    for (run, message) in [
        ("engine:new", "automation:message:new"),
        ("engine:bound", "automation:message:bound"),
    ] {
        space
            .membership
            .bind_agent_attribution("chat", Some(run), Some(message), AgentBackendKind::Acp)
            .unwrap();
        assert_eq!(on_behalf_of(run), alice.member_id);
    }
    let removed = alice.member_id.clone();
    space
        .store
        .writer()
        .call(move |c| {
            c.execute(
                "UPDATE members SET lifecycle='removed' WHERE id=?1",
                [removed],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        space.membership.bind_agent_attribution(
            "chat",
            Some("engine:later"),
            Some("automation:message:bound"),
            AgentBackendKind::Acp,
        ),
        Err(error) if error.code == StoreErrorCode::Unauthorized
    ));
}

fn listener_info() -> ListenerInfo {
    ListenerInfo {
        url: "https://127.0.0.1:8443".into(),
        fingerprint: "f".repeat(64),
        routes: vec![
            "https://192.168.1.2:8443".into(),
            "https://100.64.1.2:8443".into(),
        ],
        peer_policy: ListenerPeerPolicy::Private,
    }
}
fn remote(space: &Space, code: String) -> (LibraryMembership, EnrollmentResponse) {
    let device = space.membership.enroll(enrollment(code)).unwrap();
    let session = space
        .membership
        .session(SessionRequest {
            device_credential: device.device_credential.clone(),
        })
        .unwrap();
    (
        space.membership.for_principal(Some(session.principal)),
        device,
    )
}
#[test]
fn own_device_link_preserves_personal_member_identity_and_records_actor() {
    let space = Space::new();
    let owner = space.membership.require_owner().unwrap();
    let offer = space.membership.link_device(listener_info()).unwrap();
    assert_eq!(offer.member_id, owner);
    assert_eq!(offer.routes.len(), 2);
    assert!(offer.expires_at <= now() + 300);
    let mut request = enrollment(offer.code);
    request.form_factor = DeviceFormFactor::Phone;
    let device = space.membership.enroll(request.clone()).unwrap();
    let session = space
        .membership
        .session(SessionRequest {
            device_credential: device.device_credential.clone(),
        })
        .unwrap();
    let phone = space.membership.for_principal(Some(session.principal));
    assert!(matches!(
        phone.devices().unwrap()[0].form_factor,
        DeviceFormFactor::Phone
    ));
    // Redemption cannot create a person, even if the supplied name differs.
    assert_eq!(device.member_id, owner);
    assert_eq!(phone.devices().unwrap().len(), 1);
    assert!(space.membership.enroll(request).is_err());
    space.store.readers().read_default(|c| {
        assert_eq!(c.query_row("SELECT space_kind FROM libraries WHERE id='space'",[],|r|r.get::<_,String>(0))?,"personal");
        assert_eq!(c.query_row("SELECT count(*) FROM members",[],|r|r.get::<_,i64>(0))?,1);
        let actor:String=c.query_row("SELECT actor_json FROM mutation_actors WHERE operation_id IN (SELECT operation_id FROM core_module_receipts WHERE operation_kind='link_device')",[],|r|r.get(0))?;
        assert_eq!(serde_json::from_str::<nodex_core_contracts::Actor>(&actor).unwrap(),nodex_core_contracts::Actor::Member{member_id:owner});
        Ok(())
    }).unwrap();
    let own_offer = phone.link_device(listener_info()).unwrap();
    assert_eq!(own_offer.member_id, device.member_id);
    let pending_invite = phone
        .invite(
            InviteRequest {
                role: MemberRole::Member,
                member_id: None,
            },
            listener_info(),
        )
        .unwrap();
    phone.revoke(device.device_id).unwrap();
    assert!(
        space
            .membership
            .enroll(enrollment(pending_invite.code))
            .is_ok(),
        "Owner-issued invitations retain their independent grant policy"
    );
    assert!(
        space.membership.enroll(enrollment(own_offer.code)).is_err(),
        "Withdrawal must retire unredeemed link codes of that Member"
    );
    assert!(phone.link_device(listener_info()).is_err());
}
#[test]
fn member_administration_is_current_role_and_device_scoped() {
    let space = Space::new();
    let (member, device) = remote(&space, space.invite().code);
    assert!(member.members().is_err());
    assert!(
        member
            .invite(
                InviteRequest {
                    role: MemberRole::Owner,
                    member_id: None
                },
                listener_info()
            )
            .is_err()
    );
    assert!(
        member
            .rename(RenameSpaceRequest { name: "No".into() })
            .is_err()
    );
    let (_, other) = remote(&space, space.invite().code);
    assert_eq!(member.devices().unwrap().len(), 1);
    assert!(member.revoke(other.device_id.clone()).is_err());
    assert!(member.remove(other.member_id).is_err());
    // A role change after receipt/authentication invalidates the captured principal at the writer.
    let id = device.member_id.clone();
    space
        .store
        .writer()
        .call(move |c| {
            c.execute("UPDATE members SET role='owner' WHERE id=?1", [id])?;
            Ok(())
        })
        .unwrap();
    assert!(member.link_device(listener_info()).is_err());
    let session = space
        .membership
        .session(SessionRequest {
            device_credential: device.device_credential,
        })
        .unwrap();
    let owner = space.membership.for_principal(Some(session.principal));
    owner
        .rename(RenameSpaceRequest {
            name: "Remote Owner".into(),
        })
        .unwrap();
    assert_eq!(owner.members().unwrap().len(), 3);
    owner.revoke(other.device_id).unwrap();
    let id = device.member_id;
    space
        .store
        .writer()
        .call(move |c| {
            c.execute("UPDATE members SET role='member' WHERE id=?1", [id])?;
            Ok(())
        })
        .unwrap();
    assert!(
        owner
            .rename(RenameSpaceRequest {
                name: "Stale Owner".into()
            })
            .is_err()
    );
    assert_eq!(space.membership.name().unwrap(), "Remote Owner");
}
#[test]
fn device_links_expire_reserve_capacity_and_rate_limit_even_after_redemption() {
    let space = Space::new();
    for _ in 0..6 {
        let offer = space.membership.link_device(listener_info()).unwrap();
        space.membership.enroll(enrollment(offer.code)).unwrap();
    }
    let limited = space.membership.link_device(listener_info()).unwrap_err();
    assert_eq!(limited.code, StoreErrorCode::ResourceExhausted);
    assert!(matches!(limited.recovery,
        Some(nodex_core_contracts::CoreErrorRecovery::RetryAfter {
            budget: RemoteBudget::MemberDeviceLinks, milliseconds
        }) if (1..=3_600_000).contains(&milliseconds)));
    space
        .store
        .writer()
        .call(|c| {
            c.execute("UPDATE space_invites SET created_at=0,expires_at=0", [])?;
            Ok(())
        })
        .unwrap();
    let offer = space.membership.link_device(listener_info()).unwrap();
    space
        .store
        .writer()
        .call(|c| {
            c.execute("UPDATE space_invites SET expires_at=0", [])?;
            Ok(())
        })
        .unwrap();
    assert!(space.membership.enroll(enrollment(offer.code)).is_err());
    space
        .store
        .writer()
        .call(|c| {
            c.execute("DELETE FROM space_invites", [])?;
            Ok(())
        })
        .unwrap();
    for _ in 0..6 {
        space.membership.link_device(listener_info()).unwrap();
    }
    // Four slots remain after six active Devices and six live reservations.
    space
        .store
        .writer()
        .call(|c| {
            c.execute("UPDATE space_invites SET created_at=0", [])?;
            Ok(())
        })
        .unwrap();
    for _ in 0..4 {
        space.membership.link_device(listener_info()).unwrap();
    }
    assert!(space.membership.link_device(listener_info()).is_err());
}

#[test]
fn queued_administration_rechecks_revocation_and_role_at_the_writer() {
    use std::{
        sync::mpsc,
        thread,
        time::{Duration, Instant},
    };
    for revoke in [false, true] {
        let space = Space::new();
        let invite = space
            .membership
            .invite(
                InviteRequest {
                    role: MemberRole::Owner,
                    member_id: None,
                },
                listener_info(),
            )
            .unwrap();
        let (owner, device) = remote(&space, invite.code);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = space.store.writer();
        let blocker = thread::spawn(move || {
            writer.call(move |c| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                if revoke {
                    c.execute(
                        "UPDATE member_devices SET revoked_at=unixepoch() WHERE id=?1",
                        [device.device_id],
                    )?;
                } else {
                    c.execute(
                        "UPDATE members SET role='member' WHERE id=?1",
                        [device.member_id],
                    )?;
                }
                Ok(())
            })
        });
        started_rx.recv().unwrap();
        let pending = thread::spawn(move || {
            owner.rename(RenameSpaceRequest {
                name: "Queued forbidden write".into(),
            })
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while space.store.writer().queued_job_count() == 0 && Instant::now() < deadline {
            thread::yield_now();
        }
        let queued = space.store.writer().queued_job_count();
        release_tx.send(()).unwrap();
        blocker.join().unwrap().unwrap();
        assert!(
            queued > 0,
            "Administration must be queued behind the authority change"
        );
        let error = pending.join().unwrap().unwrap_err();
        assert_eq!(error.code, StoreErrorCode::Unauthorized);
        assert_eq!(
            error.recovery,
            Some(nodex_core_contracts::CoreErrorRecovery::RenewRemoteSession)
        );
        assert_eq!(space.membership.name().unwrap(), "Team Space");
    }
}

#[test]
fn administrative_changes_and_actor_receipts_survive_validated_store_reopen() {
    let space = Space::new();
    let device = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    space
        .membership
        .rename(RenameSpaceRequest {
            name: "Persistent Space".into(),
        })
        .unwrap();
    space.membership.revoke(device.device_id.clone()).unwrap();
    let Space {
        membership,
        store,
        _directory: directory,
    } = space;
    drop(membership);
    drop(store);
    let reopened = SqliteStoreKernel::open(directory.path())
        .expect("administration must leave a valid Store across restart");
    let membership = LibraryMembership::new(&reopened, "space".into());
    assert_eq!(membership.name().unwrap(), "Persistent Space");
    let devices = membership.devices().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, device.device_id);
    assert!(devices[0].revoked_at.is_some());
    let actors = reopened.readers().read_default(|connection| {
        Ok(connection.query_row("SELECT count(*) FROM mutation_actors WHERE operation_id IN (SELECT operation_id FROM core_module_receipts WHERE operation_kind IN ('invite_member','enroll_device','rename_space','revoke_device'))", [], |row| row.get::<_,i64>(0))?)
    }).unwrap();
    assert_eq!(actors, 4);
}

fn registration(handle: &str, needs_you: bool, finished: bool) -> PushRegistration {
    use base64::prelude::{BASE64_URL_SAFE_NO_PAD, Engine as _};
    PushRegistration {
        handle: handle.into(),
        key: BASE64_URL_SAFE_NO_PAD.encode([7_u8; 32]),
        preferences: PushPreferences {
            needs_you,
            finished,
        },
    }
}
fn notified(membership: &LibraryMembership) -> Vec<bool> {
    membership
        .devices()
        .unwrap()
        .into_iter()
        .map(|device| device.notifications_enabled)
        .collect()
}

#[test]
fn push_registrations_belong_to_their_device_and_end_with_its_authority() {
    let space = Space::new();
    let (alice, alice_phone) = remote(&space, space.invite().code);
    let (bob, bob_phone) = remote(&space, space.invite().code);
    // Only a verified Device registers, and only its own; invalid handles and keys never persist.
    assert!(
        space
            .membership
            .set_push_registration(Some(registration("handle", true, true)))
            .is_err()
    );
    let mut bad = registration("handle", true, true);
    bad.key = "A".repeat(42);
    assert!(alice.set_push_registration(Some(bad.clone())).is_err());
    // Exactly 43 characters, but trailing bits make it a non-canonical encoding.
    bad.key = format!("{}B", "A".repeat(42));
    assert!(alice.set_push_registration(Some(bad)).is_err());
    bad = registration("not a handle", true, true);
    assert!(alice.set_push_registration(Some(bad)).is_err());
    alice
        .set_push_registration(Some(registration("alice", true, false)))
        .unwrap();
    bob.set_push_registration(Some(registration("bob", true, true)))
        .unwrap();
    let recipients = space
        .membership
        .push_recipients(&alice_phone.member_id)
        .unwrap();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients[0].device_id, alice_phone.device_id);
    assert_eq!(
        recipients[0].registration,
        registration("alice", true, false)
    );
    assert_eq!(notified(&alice), vec![true]);

    // A registration that wants nothing is none; unregistering removes it.
    alice
        .set_push_registration(Some(registration("alice", false, false)))
        .unwrap();
    assert!(
        space
            .membership
            .push_recipients(&alice_phone.member_id)
            .unwrap()
            .is_empty()
    );
    assert_eq!(notified(&alice), vec![false]);
    alice
        .set_push_registration(Some(registration("alice", true, true)))
        .unwrap();
    alice.set_push_registration(None).unwrap();
    assert_eq!(notified(&alice), vec![false]);

    // The relay's "gone" forgets only the handle it reported, never a newer registration.
    bob.set_push_registration(Some(registration("bob-new", true, true)))
        .unwrap();
    assert!(
        !space
            .membership
            .forget_push_registration(bob_phone.device_id.clone(), "bob".into())
            .unwrap()
    );
    assert_eq!(
        space
            .membership
            .push_recipients(&bob_phone.member_id)
            .unwrap()[0]
            .registration
            .handle,
        "bob-new"
    );
    assert!(
        space
            .membership
            .forget_push_registration(bob_phone.device_id.clone(), "bob-new".into())
            .unwrap()
    );

    // Revoking the Device or removing the Member drops what it registered.
    bob.set_push_registration(Some(registration("bob", true, true)))
        .unwrap();
    space.membership.revoke(bob_phone.device_id).unwrap();
    assert!(
        space
            .membership
            .push_recipients(&bob_phone.member_id)
            .unwrap()
            .is_empty()
    );
    alice
        .set_push_registration(Some(registration("alice", true, true)))
        .unwrap();
    space
        .membership
        .remove(alice_phone.member_id.clone())
        .unwrap();
    space
        .store
        .readers()
        .read_default(|c| {
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM member_device_push_registrations",
                    [],
                    |r| r.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_phone_relinked_as_the_same_member_keeps_one_registration() {
    let space = Space::new();
    let invite = space.invite();
    let (first, device) = remote(&space, invite.code);
    first
        .set_push_registration(Some(registration("phone", true, true)))
        .unwrap();
    let offer = first.link_device(listener_info()).unwrap();
    let (second, relinked) = remote(&space, offer.code);
    assert_eq!(relinked.member_id, device.member_id);
    second
        .set_push_registration(Some(registration("phone", true, true)))
        .unwrap();
    let recipients = space.membership.push_recipients(&device.member_id).unwrap();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients[0].device_id, relinked.device_id);
}

#[test]
fn a_live_connection_keeps_its_device_seen_without_a_write_per_check() {
    let space = Space::new();
    let enrolled = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    let principal = space
        .membership
        .session(SessionRequest {
            device_credential: enrolled.device_credential,
        })
        .unwrap()
        .principal;
    let last_seen = |space: &Space| -> i64 {
        let device = principal.device_id.clone();
        space
            .store
            .readers()
            .read_default(move |c| {
                Ok(c.query_row(
                    "SELECT last_seen FROM member_devices WHERE id=?1",
                    [device],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    };
    let set_last_seen = |space: &Space, at: i64| {
        let device = principal.device_id.clone();
        space
            .store
            .writer()
            .call(move |c| {
                c.execute(
                    "UPDATE member_devices SET last_seen=?2 WHERE id=?1",
                    params![device, at],
                )?;
                Ok(())
            })
            .unwrap();
    };
    // A phone stream open for 38 minutes is seen now, not when its session began.
    set_last_seen(&space, now() - 38 * 60);
    space.membership.mark_seen(&principal).unwrap();
    assert!(now() - last_seen(&space) <= 1);
    // A check within the interval leaves the recent time alone.
    let recent = now() - DEVICE_SEEN_INTERVAL_SECONDS + 5;
    set_last_seen(&space, recent);
    space.membership.mark_seen(&principal).unwrap();
    assert_eq!(last_seen(&space), recent);
    // A revoked Device is never seen again.
    set_last_seen(&space, 1);
    space
        .membership
        .for_principal(Some(principal.clone()))
        .revoke(principal.device_id.clone())
        .unwrap();
    space.membership.mark_seen(&principal).unwrap();
    assert_eq!(last_seen(&space), 1);
}

#[test]
fn members_name_themselves_and_no_stored_name_is_you() {
    let space = Space::new();
    let refused = |name: &str| EnrollmentRequest {
        display_name: name.into(),
        ..enrollment(space.invite().code)
    };
    for name in ["You", " you "] {
        assert!(matches!(
            space.membership.enroll(refused(name)),
            Err(error) if error.code == StoreErrorCode::InvalidInput
        ));
    }
    let bob = space
        .membership
        .enroll(enrollment(space.invite().code))
        .unwrap();
    // Linking another Device of an existing Member never renames that Member.
    let link = space
        .membership
        .invite(
            InviteRequest {
                role: MemberRole::Member,
                member_id: Some(bob.member_id.clone()),
            },
            ListenerInfo {
                peer_policy: Default::default(),
                routes: vec![],
                url: "https://localhost".into(),
                fingerprint: "test".into(),
            },
        )
        .unwrap();
    let phone = space
        .membership
        .enroll(EnrollmentRequest {
            display_name: "You".into(),
            ..enrollment(link.code)
        })
        .unwrap();
    assert_eq!(phone.member_id, bob.member_id);
    let session = space
        .membership
        .session(SessionRequest {
            device_credential: bob.device_credential,
        })
        .unwrap();
    // The local Owner and a remote Member each rename only themselves.
    let owner = space
        .membership
        .rename_member(RenameMemberRequest {
            name: "  Jun Yu ".into(),
        })
        .unwrap();
    assert_eq!(owner.display_name, "Jun Yu");
    assert_eq!(owner.role, MemberRole::Owner);
    let remote = space.membership.for_principal(Some(session.principal));
    let renamed = remote
        .rename_member(RenameMemberRequest {
            name: "Robert".into(),
        })
        .unwrap();
    assert_eq!(
        (renamed.id.as_str(), renamed.display_name.as_str()),
        (bob.member_id.as_str(), "Robert")
    );
    for name in ["you", "YOU", " ", "Two\nlines"] {
        assert!(
            remote
                .rename_member(RenameMemberRequest { name: name.into() })
                .is_err(),
            "{name:?}"
        );
    }
    let names = space
        .membership
        .members()
        .unwrap()
        .into_iter()
        .map(|member| member.display_name)
        .collect::<Vec<_>>();
    assert_eq!(names, ["Jun Yu", "Robert"]);
}
