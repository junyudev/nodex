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
                 INSERT INTO libraries(id,profile_id,created_at,updated_at)
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
                    url: "https://localhost".into(),
                    fingerprint: "test".into(),
                },
            )
            .unwrap()
    }
}

fn enrollment(code: String) -> EnrollmentRequest {
    EnrollmentRequest {
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
