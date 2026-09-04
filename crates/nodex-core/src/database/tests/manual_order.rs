use super::*;
use nodex_core_contracts::database::{
    DatabaseListMoveUndoRecipe, DatabaseListWindow, DatabasePagePosition,
};

fn apply(
    module: &DatabaseModule,
    operation: &str,
    intent: DatabaseIntent,
) -> Result<DatabaseApplyOutcome, CoreError> {
    module.apply(
        &context(),
        ModuleApplyRequest {
            contract_version: DATABASE_CONTRACT_VERSION,
            operation_id: operation.to_owned(),
            store_epoch: StoreEpoch("epoch-1".to_owned()),
            intent: vec![intent],
        },
    )
}

fn seed(
    kernel: &SqliteStoreKernel,
    pages: &[&'static str],
    descending: bool,
    explicit_positions: bool,
) -> DatabaseModule {
    let ranks = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let module = seed_grouped_fixture(
        kernel,
        pages
            .iter()
            .zip(ranks)
            .map(|(page_id, rank)| GroupRowSpec {
                page_id,
                title: page_id,
                value_json: Some("\"triage\""),
                rank_key: Some(rank),
            })
            .collect(),
    );
    let mut config = view_config(
        json!({"kind":"group", "operator":"and", "children":[]}),
        None,
        &["status"],
    );
    config["rules"]["sorts"] = json!([{
        "field": {"kind":"manual"},
        "direction": if descending { "desc" } else { "asc" },
        "nulls":"last"
    }]);
    config["presentation"]["hierarchy"] = json!({"showSubPages":true,"nestedSubPages":true});
    apply(
        &module,
        "manual-list:configure",
        DatabaseIntent::PutView {
            database_id: DATABASE_ID.to_owned(),
            data_source_id: SOURCE_ID.to_owned(),
            view_id: VIEW_ID.to_owned(),
            expected_revision: 1,
            name: "Manual List".to_owned(),
            layout: DatabaseViewLayout::List,
            definition: view_definition(config),
            is_default: true,
            before_view_id: None,
        },
    )
    .expect("configure manual List");
    if !explicit_positions {
        return module;
    }
    let position_pages = if descending {
        pages.iter().rev().copied().collect::<Vec<_>>()
    } else {
        pages.to_vec()
    };
    apply(
        &module,
        "manual-list:explicit-order",
        DatabaseIntent::PositionPages {
            view_id: VIEW_ID.to_owned(),
            pages: position_pages
                .iter()
                .map(|page_id| DatabasePagePosition {
                    page_id: (*page_id).to_owned(),
                    expected_position_revision: 0,
                })
                .collect(),
            before_page_id: None,
        },
    )
    .expect("establish explicit manual positions");
    module
}

fn window(module: &DatabaseModule) -> DatabaseListWindow {
    read_list_window(module, 50, None).expect("read List")
}

fn occurrence(window: &DatabaseListWindow, page_id: &str) -> String {
    window
        .rows
        .items
        .iter()
        .find_map(|row| match row {
            DatabaseListProjectionRow::Page {
                occurrence_key,
                summary,
                transient_kind: DatabaseListTransientKind::None,
                ..
            } if summary.page_id == page_id => Some(occurrence_key.clone()),
            _ => None,
        })
        .expect("concrete Page occurrence")
}

fn state(module: &DatabaseModule) -> Vec<(String, Option<String>)> {
    window(module)
        .rows
        .items
        .into_iter()
        .filter_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. } => {
                Some((summary.page_id, summary.task_parent_page_id))
            }
            _ => None,
        })
        .collect()
}

fn move_pages(
    module: &DatabaseModule,
    operation: &str,
    pages: &[&str],
    target: &str,
    edge: DatabaseListMoveEdge,
) -> Result<DatabaseApplyOutcome, CoreError> {
    let before = window(module);
    apply(
        module,
        operation,
        DatabaseIntent::MoveListOccurrences {
            view_id: VIEW_ID.to_owned(),
            preferences_override: DatabaseViewPreferencesOverrideInput::default(),
            expected_projection: list_projection_expectation(&before),
            initiator_occurrence_key: occurrence(&before, pages[0]),
            selection: DatabaseListMoveSelection::Explicit {
                occurrence_keys: pages.iter().map(|page| occurrence(&before, page)).collect(),
            },
            target: DatabaseListMoveTarget::Page {
                occurrence_key: occurrence(&before, target),
                edge,
            },
        },
    )
}

fn recipe(outcome: DatabaseApplyOutcome) -> DatabaseListMoveUndoRecipe {
    match outcome
        .committed
        .receipt
        .operation_outcomes
        .into_iter()
        .next()
        .expect("move outcome")
    {
        DatabaseOperationOutcome::ListOccurrenceMove { undo_recipe, .. }
        | DatabaseOperationOutcome::ListOccurrenceMoveUndo { undo_recipe, .. } => *undo_recipe,
        _ => panic!("List move inverse"),
    }
}

fn undo(
    module: &DatabaseModule,
    operation: &str,
    recipe: DatabaseListMoveUndoRecipe,
) -> Result<DatabaseApplyOutcome, CoreError> {
    apply(
        module,
        operation,
        DatabaseIntent::UndoListOccurrenceMove { recipe },
    )
}

#[test]
fn interleaved_child_positions_do_not_turn_root_slot_noops_into_moves() {
    for descending in [false, true] {
        let directory = tempdir().expect("Profile");
        let kernel =
            SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).expect("store");
        let module = seed(
            &kernel,
            &["page:a", "page:x", "page:b", "page:p"],
            descending,
            true,
        );
        apply_task_parent(
            &module,
            "manual-list:nest",
            &[("page:x", 1)],
            Some("page:p"),
            None,
        )
        .expect("nest interleaved child");
        let before = state(&module);
        assert_eq!(
            before
                .iter()
                .filter(|(_, parent)| parent.is_none())
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            if descending {
                vec!["page:p", "page:b", "page:a"]
            } else {
                vec!["page:a", "page:b", "page:p"]
            }
        );
        let revisions = || {
            window(&module)
                .rows
                .items
                .into_iter()
                .filter_map(|row| match row {
                    DatabaseListProjectionRow::Page { summary, .. } => Some((
                        summary.page_id,
                        summary.position_revision,
                        summary.task_parent_value_revision,
                    )),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let initial_revisions = revisions();
        for (operation, source, target, edge) in [
            (
                "manual-list:noop-a",
                "page:a",
                "page:b",
                if descending {
                    DatabaseListMoveEdge::After
                } else {
                    DatabaseListMoveEdge::Before
                },
            ),
            (
                "manual-list:noop-b",
                "page:b",
                "page:a",
                if descending {
                    DatabaseListMoveEdge::Before
                } else {
                    DatabaseListMoveEdge::After
                },
            ),
        ] {
            assert_eq!(
                move_pages(&module, operation, &[source], target, edge)
                    .expect_err("the root slot is unchanged")
                    .code,
                CoreErrorCode::InvalidInput
            );
            assert_eq!(state(&module), before);
            assert_eq!(
                revisions(),
                initial_revisions,
                "a root-slot no-op cannot rewrite positions or Parents"
            );
        }
    }
}

#[test]
fn descending_default_positions_preserve_visible_root_slot_noops() {
    let directory = tempdir().expect("Profile");
    let kernel =
        SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).expect("store");
    let module = seed(
        &kernel,
        &["page:a", "page:x", "page:b", "page:p"],
        true,
        false,
    );
    apply_task_parent(
        &module,
        "manual-list:nest",
        &[("page:x", 1)],
        Some("page:p"),
        None,
    )
    .expect("nest child with default View position");
    assert!(
        window(&module).rows.items.iter().all(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. } =>
                summary.rank_key.is_none() && summary.position_revision.is_none(),
            _ => true,
        }),
        "complete default ordering does not expose explicit-position metadata"
    );
    let before = state(&module);
    assert_eq!(
        before
            .iter()
            .filter(|(_, parent)| parent.is_none())
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["page:p", "page:b", "page:a"]
    );
    let result = move_pages(
        &module,
        "manual-list:default-desc-noop",
        &["page:a"],
        "page:b",
        DatabaseListMoveEdge::After,
    );
    assert_eq!(
        result
            .expect_err("the visible default root slot is unchanged")
            .code,
        CoreErrorCode::InvalidInput
    );
    assert_eq!(state(&module), before);
}

#[test]
fn freezing_default_positions_preserves_untouched_manual_order() {
    for descending in [false, true] {
        for nulls in ["first", "last"] {
            let directory = tempdir().expect("Profile");
            let kernel = SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap())
                .expect("store");
            let module = seed(
                &kernel,
                &["page:a", "page:b", "page:c", "page:d"],
                descending,
                false,
            );
            let mut config = view_config(
                json!({"kind":"group", "operator":"and", "children":[]}),
                None,
                &["status"],
            );
            config["rules"]["sorts"] = json!([{
                "field":{"kind":"manual"}, "direction":if descending {"desc"} else {"asc"}, "nulls":nulls
            }]);
            config["presentation"]["hierarchy"] =
                json!({"showSubPages":true,"nestedSubPages":true});
            apply(
                &module,
                "manual-list:null-policy",
                DatabaseIntent::PutView {
                    database_id: DATABASE_ID.to_owned(),
                    data_source_id: SOURCE_ID.to_owned(),
                    view_id: VIEW_ID.to_owned(),
                    expected_revision: 2,
                    name: "Manual List".to_owned(),
                    layout: DatabaseViewLayout::List,
                    definition: view_definition(config),
                    is_default: true,
                    before_view_id: None,
                },
            )
            .expect("configure manual null policy");
            let before = state(&module);
            let moved_page = before.last().unwrap().0.clone();
            let first_page = before.first().unwrap().0.clone();
            assert!(window(&module).rows.items.iter().all(|row| match row {
                DatabaseListProjectionRow::Page { summary, .. } =>
                    summary.position_revision.is_none(),
                _ => true,
            }));
            apply(
                &module,
                "manual-list:freeze",
                DatabaseIntent::PositionPages {
                    view_id: VIEW_ID.to_owned(),
                    pages: vec![DatabasePagePosition {
                        page_id: moved_page.clone(),
                        expected_position_revision: 0,
                    }],
                    before_page_id: Some(first_page),
                },
            )
            .expect("position one Page and freeze default metadata");
            let after = state(&module);
            assert_eq!(after.first().unwrap().0, moved_page);
            assert_eq!(
                after
                    .into_iter()
                    .filter(|(page, _)| page != &moved_page)
                    .collect::<Vec<_>>(),
                before
                    .into_iter()
                    .filter(|(page, _)| page != &moved_page)
                    .collect::<Vec<_>>(),
                "epoch changes cannot reorder untouched Pages ({descending}, {nulls})"
            );
            assert!(
                window(&module).rows.items.iter().all(|row| match row {
                    DatabaseListProjectionRow::Page { summary, .. } =>
                        summary.position_revision == Some(1),
                    _ => true,
                }),
                "the command froze optional position metadata for the old default suffix"
            );
        }
    }
}

#[test]
fn root_undo_ignores_child_positions_but_guards_promoted_root_neighbours() {
    let directory = tempdir().expect("Profile");
    let kernel =
        SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).expect("store");
    let module = seed(
        &kernel,
        &["page:a", "page:x", "page:b", "page:p"],
        false,
        true,
    );
    apply_task_parent(
        &module,
        "manual-list:nest",
        &[("page:x", 1)],
        Some("page:p"),
        None,
    )
    .expect("nest unrelated child");
    let before = state(&module);
    let first_recipe = recipe(
        move_pages(
            &module,
            "manual-list:move",
            &["page:b"],
            "page:a",
            DatabaseListMoveEdge::Before,
        )
        .expect("move root"),
    );
    let moved = state(&module);
    let x_revision = window(&module)
        .rows
        .items
        .into_iter()
        .find_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. } if summary.page_id == "page:x" => {
                Some(summary.position_revision.unwrap_or(0))
            }
            _ => None,
        })
        .expect("child position revision");
    apply(
        &module,
        "manual-list:child-position",
        DatabaseIntent::PositionPages {
            view_id: VIEW_ID.to_owned(),
            pages: vec![DatabasePagePosition {
                page_id: "page:x".to_owned(),
                expected_position_revision: x_revision,
            }],
            before_page_id: Some("page:a".to_owned()),
        },
    )
    .expect("move unrelated child's View position into the root interval");
    assert_eq!(state(&module), moved);
    let redo = recipe(
        undo(&module, "manual-list:undo", first_recipe)
            .expect("child position does not invalidate root Undo"),
    );
    assert_eq!(state(&module), before);
    let next_undo = recipe(
        undo(&module, "manual-list:redo", redo)
            .expect("child position does not invalidate root Redo"),
    );
    assert_eq!(state(&module), moved);
    let x_revision = window(&module)
        .rows
        .items
        .into_iter()
        .find_map(|row| match row {
            DatabaseListProjectionRow::Page { summary, .. } if summary.page_id == "page:x" => {
                Some(summary.position_revision.unwrap_or(0))
            }
            _ => None,
        })
        .expect("latest child position");
    apply(
        &module,
        "manual-list:child-position-after-redo",
        DatabaseIntent::PositionPages {
            view_id: VIEW_ID.to_owned(),
            pages: vec![DatabasePagePosition {
                page_id: "page:x".to_owned(),
                expected_position_revision: x_revision,
            }],
            before_page_id: Some("page:a".to_owned()),
        },
    )
    .expect("place child immediately before the guarded successor");
    apply_task_parent(&module, "manual-list:promote", &[("page:x", 2)], None, None)
        .expect("promote child in the guarded root slot");
    let promoted = state(&module);
    assert_eq!(
        promoted
            .iter()
            .filter(|(_, parent)| parent.is_none())
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["page:b", "page:x", "page:a", "page:p"]
    );
    assert_eq!(
        undo(&module, "manual-list:conflicting-undo", next_undo)
            .expect_err("new root neighbour invalidates Undo")
            .code,
        CoreErrorCode::RevisionConflict
    );
    assert_eq!(state(&module), promoted, "conflicting Undo is atomic");
}

#[test]
fn mixed_root_and_two_parent_selection_restores_each_logical_run() {
    let directory = tempdir().expect("Profile");
    let kernel =
        SqliteStoreKernel::open_test(&directory.path().canonicalize().unwrap()).expect("store");
    let module = seed(
        &kernel,
        &[
            "page:r", "page:p", "page:x", "page:y", "page:q", "page:z", "page:w", "page:s",
        ],
        false,
        true,
    );
    apply_task_parent(
        &module,
        "manual-list:children-p",
        &[("page:x", 1), ("page:y", 1)],
        Some("page:p"),
        None,
    )
    .expect("first sibling run");
    apply_task_parent(
        &module,
        "manual-list:children-q",
        &[("page:z", 1), ("page:w", 1)],
        Some("page:q"),
        None,
    )
    .expect("second sibling run");
    let before = state(&module);
    let inverse = recipe(
        move_pages(
            &module,
            "manual-list:mixed-move",
            &["page:r", "page:x", "page:z"],
            "page:s",
            DatabaseListMoveEdge::After,
        )
        .expect("move mixed selection"),
    );
    let moved = state(&module);
    assert_ne!(moved, before);
    for page in ["page:r", "page:x", "page:z"] {
        assert_eq!(moved.iter().find(|(id, _)| id == page).unwrap().1, None);
    }
    let redo = recipe(
        undo(&module, "manual-list:mixed-undo", inverse).expect("restore root and both child runs"),
    );
    assert_eq!(state(&module), before);
    undo(&module, "manual-list:mixed-redo", redo).expect("redo mixed selection");
    assert_eq!(state(&module), moved);
}
