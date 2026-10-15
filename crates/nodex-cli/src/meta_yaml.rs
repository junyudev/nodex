use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, NaiveDate};
pub use nodex_core_contracts::library::{
    PageMetaProjectionV2, ProjectedIdentityV1, ProjectedPropertyTypeV1, ProjectedPropertyV1,
    ProjectedPropertyValueV1, ProjectedRelationSummaryV1, ProjectedScheduleV1,
};
use serde_json::Number;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

use crate::error::{CliError, CliErrorCode};

pub const MAX_META_YAML_BYTES: usize = 1024 * 1024;
pub const MAX_META_YAML_SCALAR_BYTES: usize = 64 * 1024;
pub const MAX_META_YAML_NODES: usize = 20_000;
pub const MAX_META_YAML_DEPTH: usize = 32;
pub const MAX_META_YAML_PROPERTIES: usize = 256;
pub const MAX_META_YAML_SEQUENCE: usize = 256;

pub type PageMetaV2 = PageMetaProjectionV2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DraftMetadataChange {
    pub title: Option<String>,
}

pub fn parse(input: &[u8]) -> Result<PageMetaV2, CliError> {
    if input.len() > MAX_META_YAML_BYTES {
        return Err(invalid(format!(
            "meta.yaml exceeds the {MAX_META_YAML_BYTES}-byte limit"
        )));
    }
    let input = std::str::from_utf8(input).map_err(|_| {
        CliError::new(
            CliErrorCode::MetaYamlSyntax,
            "meta.yaml must be valid UTF-8",
        )
    })?;
    reject_directives(input)?;

    let mut receiver = ProfileReceiver::default();
    let mut parser = Parser::new_from_str(input);
    parser.load(&mut receiver, true).map_err(|error| {
        CliError::new(CliErrorCode::MetaYamlSyntax, error.info())
            .at_line(error.marker().line())
            .at_column(error.marker().col())
    })?;
    let root = receiver.finish()?;
    validate_page(root)
}

pub fn compare_draft_metadata(
    base: &PageMetaV2,
    work: &PageMetaV2,
) -> Result<DraftMetadataChange, CliError> {
    if base.id != work.id {
        return Err(CliError::new(
            CliErrorCode::PageIdMismatch,
            "work meta.yaml must retain the draft Page ID",
        )
        .at_path("id"));
    }

    let mut read_only_paths = Vec::new();
    if base.page_key != work.page_key {
        read_only_paths.push("page_key".to_owned());
    }
    let base_properties = properties_by_id(&base.properties)?;
    let work_properties = properties_by_id(&work.properties)?;
    if base_properties != work_properties {
        let property_ids = base_properties
            .keys()
            .chain(work_properties.keys())
            .collect::<BTreeSet<_>>();
        for property_id in property_ids {
            if base_properties.get(property_id) != work_properties.get(property_id) {
                read_only_paths.push(format!("properties.{property_id}"));
                if read_only_paths.len() == 16 {
                    break;
                }
            }
        }
    }
    if base.schedule != work.schedule && read_only_paths.len() < 16 {
        read_only_paths.push("schedule".to_owned());
    }
    if !read_only_paths.is_empty() {
        return Err(CliError::new(
            CliErrorCode::DraftReadOnlyFieldChanged,
            format!(
                "draft changed read-only metadata: {}",
                read_only_paths.join(", ")
            ),
        )
        .at_path(read_only_paths[0].clone()));
    }

    Ok(DraftMetadataChange {
        title: (base.title_markdown != work.title_markdown).then(|| work.title_markdown.clone()),
    })
}

fn properties_by_id(
    properties: &[ProjectedPropertyV1],
) -> Result<BTreeMap<&str, &ProjectedPropertyV1>, CliError> {
    let mut indexed = BTreeMap::new();
    for property in properties {
        if indexed
            .insert(property.property_id.as_str(), property)
            .is_some()
        {
            return Err(invalid("metadata repeats a Property ID")
                .at_path(format!("properties.{}", property.property_id)));
        }
    }
    Ok(indexed)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Span {
    line: usize,
    column: usize,
}

impl From<Marker> for Span {
    fn from(marker: Marker) -> Self {
        Self {
            line: marker.line(),
            column: marker.col(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SpannedValue {
    value: Value,
    span: Span,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Value {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Sequence(Vec<SpannedValue>),
    Mapping(BTreeMap<String, SpannedValue>),
}

#[derive(Debug)]
enum Frame {
    Sequence {
        span: Span,
        values: Vec<SpannedValue>,
    },
    Mapping {
        span: Span,
        values: BTreeMap<String, SpannedValue>,
        pending_key: Option<(String, Span)>,
    },
}

#[derive(Default)]
struct ProfileReceiver {
    documents: usize,
    nodes: usize,
    frames: Vec<Frame>,
    root: Option<SpannedValue>,
    error: Option<CliError>,
}

impl ProfileReceiver {
    fn finish(self) -> Result<SpannedValue, CliError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        if self.documents != 1 {
            return Err(invalid("meta.yaml must contain exactly one document"));
        }
        if !self.frames.is_empty() {
            return Err(invalid("meta.yaml contains an incomplete collection"));
        }
        self.root
            .ok_or_else(|| invalid("meta.yaml must contain one root mapping"))
    }

    fn receive(&mut self, event: Event, marker: Marker) -> Result<(), CliError> {
        if self.error.is_some() {
            return Ok(());
        }
        let span = Span::from(marker);
        match event {
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => Ok(()),
            Event::DocumentStart => {
                self.documents += 1;
                if self.documents > 1 {
                    return Err(at_span(
                        invalid("meta.yaml must contain exactly one document"),
                        span,
                    ));
                }
                Ok(())
            }
            Event::Alias(_) => Err(at_span(
                invalid("YAML aliases are not allowed in meta.yaml"),
                span,
            )),
            Event::Scalar(raw, style, anchor, tag) => {
                reject_anchor_or_tag(anchor, tag.is_some(), span)?;
                if raw.len() > MAX_META_YAML_SCALAR_BYTES {
                    return Err(at_span(
                        invalid(format!(
                            "YAML scalar exceeds the {MAX_META_YAML_SCALAR_BYTES}-byte limit"
                        )),
                        span,
                    ));
                }
                self.add_node(SpannedValue {
                    value: parse_scalar(&raw, style, span)?,
                    span,
                })
            }
            Event::SequenceStart(anchor, tag) => {
                reject_anchor_or_tag(anchor, tag.is_some(), span)?;
                self.begin_frame(Frame::Sequence {
                    span,
                    values: Vec::new(),
                })
            }
            Event::MappingStart(anchor, tag) => {
                reject_anchor_or_tag(anchor, tag.is_some(), span)?;
                self.begin_frame(Frame::Mapping {
                    span,
                    values: BTreeMap::new(),
                    pending_key: None,
                })
            }
            Event::SequenceEnd => {
                let Some(Frame::Sequence { span, values }) = self.frames.pop() else {
                    return Err(at_span(invalid("unexpected YAML sequence end"), span));
                };
                self.add_node(SpannedValue {
                    value: Value::Sequence(values),
                    span,
                })
            }
            Event::MappingEnd => {
                let Some(Frame::Mapping {
                    span,
                    values,
                    pending_key,
                }) = self.frames.pop()
                else {
                    return Err(at_span(invalid("unexpected YAML mapping end"), span));
                };
                if pending_key.is_some() {
                    return Err(at_span(invalid("YAML mapping key has no value"), span));
                }
                self.add_node(SpannedValue {
                    value: Value::Mapping(values),
                    span,
                })
            }
        }
    }

    fn begin_frame(&mut self, frame: Frame) -> Result<(), CliError> {
        self.nodes += 1;
        if self.nodes > MAX_META_YAML_NODES {
            return Err(invalid(format!(
                "meta.yaml exceeds the {MAX_META_YAML_NODES}-node limit"
            )));
        }
        if self.frames.len() >= MAX_META_YAML_DEPTH {
            return Err(invalid(format!(
                "meta.yaml exceeds the {MAX_META_YAML_DEPTH}-level depth limit"
            )));
        }
        self.frames.push(frame);
        Ok(())
    }

    fn add_node(&mut self, node: SpannedValue) -> Result<(), CliError> {
        self.nodes += 1;
        if self.nodes > MAX_META_YAML_NODES {
            return Err(at_span(
                invalid(format!(
                    "meta.yaml exceeds the {MAX_META_YAML_NODES}-node limit"
                )),
                node.span,
            ));
        }
        let Some(frame) = self.frames.last_mut() else {
            if self.root.replace(node).is_some() {
                return Err(invalid("meta.yaml must contain one root value"));
            }
            return Ok(());
        };
        match frame {
            Frame::Sequence { values, .. } => {
                if values.len() == MAX_META_YAML_SEQUENCE {
                    return Err(at_span(
                        invalid(format!(
                            "YAML sequence exceeds the {MAX_META_YAML_SEQUENCE}-item limit"
                        )),
                        node.span,
                    ));
                }
                values.push(node);
                Ok(())
            }
            Frame::Mapping {
                values,
                pending_key,
                ..
            } => {
                if let Some((key, key_span)) = pending_key.take() {
                    if key == "<<" {
                        return Err(at_span(
                            invalid("YAML merge keys are not allowed in meta.yaml"),
                            key_span,
                        ));
                    }
                    if values.insert(key.clone(), node).is_some() {
                        return Err(at_span(
                            invalid(format!("duplicate YAML mapping key '{key}'")),
                            key_span,
                        ));
                    }
                    return Ok(());
                }
                let Value::String(key) = node.value else {
                    return Err(at_span(
                        invalid("YAML mapping keys must be strings"),
                        node.span,
                    ));
                };
                *pending_key = Some((key, node.span));
                Ok(())
            }
        }
    }
}

impl MarkedEventReceiver for ProfileReceiver {
    fn on_event(&mut self, event: Event, marker: Marker) {
        if let Err(error) = self.receive(event, marker) {
            self.error = Some(error);
        }
    }
}

fn reject_directives(input: &str) -> Result<(), CliError> {
    for (index, line) in input.lines().enumerate() {
        if line.trim_start().starts_with('%') {
            return Err(CliError::new(
                CliErrorCode::MetaYamlInvalid,
                "YAML directives are not allowed in meta.yaml",
            )
            .at_line(index + 1)
            .at_column(line.len() - line.trim_start().len() + 1));
        }
    }
    Ok(())
}

fn reject_anchor_or_tag(anchor: usize, tagged: bool, span: Span) -> Result<(), CliError> {
    if anchor != 0 {
        return Err(at_span(
            invalid("YAML anchors are not allowed in meta.yaml"),
            span,
        ));
    }
    if tagged {
        return Err(at_span(
            invalid("explicit YAML tags are not allowed in meta.yaml"),
            span,
        ));
    }
    Ok(())
}

fn parse_scalar(raw: &str, style: TScalarStyle, span: Span) -> Result<Value, CliError> {
    if style != TScalarStyle::Plain {
        return Ok(Value::String(raw.to_owned()));
    }
    match raw {
        "null" | "" => return Ok(Value::Null),
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    if valid_json_number(raw) {
        let number = raw
            .parse::<Number>()
            .map_err(|_| at_span(invalid("number is outside the supported JSON range"), span))?;
        return Ok(Value::Number(number));
    }
    if resembles_non_json_number(raw) {
        return Err(at_span(
            invalid(format!("non-JSON numeric scalar '{raw}' is not allowed")),
            span,
        ));
    }
    Ok(Value::String(raw.to_owned()))
}

fn valid_json_number(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = usize::from(bytes[0] == b'-');
    if index == bytes.len() {
        return false;
    }
    if bytes[index] == b'0' {
        index += 1;
        if index < bytes.len() && bytes[index].is_ascii_digit() {
            return false;
        }
    } else if bytes[index].is_ascii_digit() && bytes[index] != b'0' {
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
    } else {
        return false;
    }
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    if index < bytes.len() && matches!(bytes[index], b'e' | b'E') {
        index += 1;
        if index < bytes.len() && matches!(bytes[index], b'+' | b'-') {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

fn resembles_non_json_number(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        ".inf" | "+.inf" | "-.inf" | ".nan" | "~" | "null"
    ) || value.starts_with('+')
        || value
            .contains('_')
            .then(|| value.replace('_', ""))
            .is_some_and(|compact| valid_json_number(&compact))
        || lower.starts_with("0x")
        || lower.starts_with("0o")
        || lower.starts_with("0b")
        || is_leading_zero_integer(value)
        || is_sexagesimal(value)
}

fn is_leading_zero_integer(value: &str) -> bool {
    let unsigned = value.strip_prefix('-').unwrap_or(value);
    unsigned.len() > 1
        && unsigned.starts_with('0')
        && unsigned.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_sexagesimal(value: &str) -> bool {
    value.contains(':')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b':' || byte == b'-')
}

fn validate_page(root: SpannedValue) -> Result<PageMetaV2, CliError> {
    let root_span = root.span;
    let mut root = expect_mapping(root, "", "top-level meta.yaml value")?;
    let page_key = root
        .remove("page_key")
        .map(validate_page_key)
        .transpose()?
        .flatten();
    expect_exact_keys(
        &root,
        &["id", "title", "properties", "schedule"],
        root_span,
        "",
    )?;
    let id = expect_bounded_string(take(&mut root, "id", "")?, "id", 512)?;
    if id.is_empty() {
        return Err(invalid("Page id must not be empty").at_path("id"));
    }
    let title = expect_bounded_string(take(&mut root, "title", "")?, "title", 4_096)?;
    if title.contains(['\n', '\r']) {
        return Err(invalid("Page title must be one inline-Markdown line").at_path("title"));
    }
    let properties_node = take(&mut root, "properties", "")?;
    let properties_span = properties_node.span;
    let property_nodes = expect_mapping(properties_node, "properties", "properties")?;
    if property_nodes.len() > MAX_META_YAML_PROPERTIES {
        return Err(at_span(
            invalid(format!(
                "properties exceeds the {MAX_META_YAML_PROPERTIES}-property limit"
            ))
            .at_path("properties"),
            properties_span,
        ));
    }
    let mut properties = BTreeMap::new();
    for (property_id, property) in property_nodes {
        if property_id.is_empty() || property_id.len() > 512 {
            return Err(at_span(
                invalid("Property ID is empty or oversized")
                    .at_path(format!("properties.{property_id}")),
                property.span,
            ));
        }
        properties.insert(
            property_id.clone(),
            validate_property(property, &property_id)?,
        );
    }
    let schedule_node = take(&mut root, "schedule", "")?;
    let schedule = match schedule_node.value {
        Value::Null => None,
        _ => Some(validate_schedule(schedule_node)?),
    };
    Ok(PageMetaProjectionV2 {
        id,
        page_key,
        title_markdown: title,
        properties: properties.into_values().collect(),
        schedule,
    })
}

fn validate_page_key(value: SpannedValue) -> Result<Option<String>, CliError> {
    if matches!(&value.value, Value::Null) {
        return Ok(None);
    }
    let page_key = expect_bounded_string(value, "page_key", 28)?;
    let Some((prefix, number)) = page_key.split_once('-') else {
        return Err(invalid("page_key must be canonical PREFIX-NUMBER").at_path("page_key"));
    };
    let prefix_is_canonical = (2..=8).contains(&prefix.len())
        && prefix
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_uppercase() || (index > 0 && byte.is_ascii_digit()));
    let number_is_canonical = !number.is_empty()
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && number.parse::<i64>().is_ok_and(|number| number > 0);
    if prefix_is_canonical && number_is_canonical {
        return Ok(Some(page_key));
    }
    Err(invalid("page_key must be canonical PREFIX-NUMBER").at_path("page_key"))
}

fn validate_property(
    property: SpannedValue,
    property_id: &str,
) -> Result<ProjectedPropertyV1, CliError> {
    let path = format!("properties.{property_id}");
    let span = property.span;
    let mut property = expect_mapping(property, &path, "Property value")?;
    expect_exact_keys(&property, &["name", "type", "value"], span, &path)?;
    let name = expect_bounded_string(
        take(&mut property, "name", &path)?,
        &format!("{path}.name"),
        4_096,
    )?;
    let type_path = format!("{path}.type");
    let value_type = match expect_bounded_string(
        take(&mut property, "type", &path)?,
        &type_path,
        32,
    )?
    .as_str()
    {
        "text" => ProjectedPropertyTypeV1::Text,
        "number" => ProjectedPropertyTypeV1::Number,
        "checkbox" => ProjectedPropertyTypeV1::Checkbox,
        "select" => ProjectedPropertyTypeV1::Select,
        "multi_select" => ProjectedPropertyTypeV1::MultiSelect,
        "date" => ProjectedPropertyTypeV1::Date,
        "datetime" => ProjectedPropertyTypeV1::Datetime,
        "relation" => ProjectedPropertyTypeV1::Relation,
        _ => return Err(invalid("unsupported Property type").at_path(type_path)),
    };
    let value_path = format!("{path}.value");
    let value = validate_property_value(
        take(&mut property, "value", &path)?,
        value_type,
        &value_path,
    )?;
    Ok(ProjectedPropertyV1 {
        property_id: property_id.to_owned(),
        name,
        value_type,
        value,
    })
}

fn validate_property_value(
    value: SpannedValue,
    value_type: ProjectedPropertyTypeV1,
    path: &str,
) -> Result<ProjectedPropertyValueV1, CliError> {
    let span = value.span;
    if matches!(value.value, Value::Null) {
        return Ok(ProjectedPropertyValueV1::Null);
    }
    match (value_type, value.value) {
        (ProjectedPropertyTypeV1::Text, Value::String(value)) => {
            bounded_string(value, span, path, MAX_META_YAML_SCALAR_BYTES)
                .map(ProjectedPropertyValueV1::Text)
        }
        (ProjectedPropertyTypeV1::Number, Value::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(ProjectedPropertyValueV1::Number)
            .ok_or_else(|| invalid("number is outside the supported finite range").at_path(path)),
        (ProjectedPropertyTypeV1::Checkbox, Value::Bool(value)) => {
            Ok(ProjectedPropertyValueV1::Checkbox(value))
        }
        (ProjectedPropertyTypeV1::Select, Value::Mapping(map)) => {
            validate_identity(map, span, path).map(ProjectedPropertyValueV1::Identity)
        }
        (ProjectedPropertyTypeV1::MultiSelect, Value::Sequence(values)) => {
            if values.len() > MAX_META_YAML_SEQUENCE {
                return Err(at_span(
                    invalid("multi_select value exceeds the sequence limit").at_path(path),
                    span,
                ));
            }
            values
                .into_iter()
                .enumerate()
                .map(|(index, value)| {
                    let item_span = value.span;
                    let map =
                        expect_mapping(value, &format!("{path}[{index}]"), "multi_select item")?;
                    validate_identity(map, item_span, &format!("{path}[{index}]"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(ProjectedPropertyValueV1::Identities)
        }
        (ProjectedPropertyTypeV1::Relation, Value::Mapping(mut summary)) => {
            expect_exact_keys(
                &summary,
                &["targets", "total_count", "unavailable_count", "has_more"],
                span,
                path,
            )?;
            let targets_path = format!("{path}.targets");
            let targets_node = take(&mut summary, "targets", path)?;
            let targets_span = targets_node.span;
            let Value::Sequence(targets) = targets_node.value else {
                return Err(at_span(
                    invalid("relation targets must be a sequence").at_path(targets_path),
                    targets_span,
                ));
            };
            if targets.len() > 3 {
                return Err(at_span(
                    invalid("relation summary exposes at most three targets").at_path(targets_path),
                    targets_span,
                ));
            }
            let targets = targets
                .into_iter()
                .enumerate()
                .map(|(index, target)| {
                    let item_path = format!("{targets_path}[{index}]");
                    let item_span = target.span;
                    let map = expect_mapping(target, &item_path, "relation target")?;
                    validate_identity(map, item_span, &item_path)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let total_count = expect_nonnegative_i64(
                take(&mut summary, "total_count", path)?,
                &format!("{path}.total_count"),
            )?;
            let unavailable_count = expect_nonnegative_i64(
                take(&mut summary, "unavailable_count", path)?,
                &format!("{path}.unavailable_count"),
            )?;
            let has_more_node = take(&mut summary, "has_more", path)?;
            let has_more = match has_more_node.value {
                Value::Bool(value) => value,
                _ => {
                    return Err(at_span(
                        invalid("relation has_more must be boolean")
                            .at_path(format!("{path}.has_more")),
                        has_more_node.span,
                    ));
                }
            };
            if total_count < unavailable_count + targets.len() as i64
                || has_more != (total_count > targets.len() as i64)
            {
                return Err(invalid("relation summary counts are inconsistent").at_path(path));
            }
            Ok(ProjectedPropertyValueV1::Relation(
                ProjectedRelationSummaryV1 {
                    targets,
                    total_count,
                    unavailable_count,
                    has_more,
                },
            ))
        }
        (ProjectedPropertyTypeV1::Date, Value::String(value)) => {
            NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .map_err(|_| invalid("date value must use YYYY-MM-DD").at_path(path))?;
            Ok(ProjectedPropertyValueV1::Date(value))
        }
        (ProjectedPropertyTypeV1::Datetime, Value::String(value)) => {
            validate_rfc3339(&value, path)?;
            Ok(ProjectedPropertyValueV1::Datetime(value))
        }
        _ => Err(at_span(
            invalid("Property value does not match its declared type").at_path(path),
            span,
        )),
    }
}

fn expect_nonnegative_i64(value: SpannedValue, path: &str) -> Result<i64, CliError> {
    let span = value.span;
    match value.value {
        Value::Number(value) => value.as_i64().filter(|value| *value >= 0).ok_or_else(|| {
            at_span(
                invalid("count must be a non-negative integer").at_path(path),
                span,
            )
        }),
        _ => Err(at_span(
            invalid("count must be a non-negative integer").at_path(path),
            span,
        )),
    }
}

fn validate_identity(
    mut map: BTreeMap<String, SpannedValue>,
    span: Span,
    path: &str,
) -> Result<ProjectedIdentityV1, CliError> {
    expect_exact_keys(&map, &["id", "name"], span, path)?;
    let id = expect_bounded_string(take(&mut map, "id", path)?, &format!("{path}.id"), 512)?;
    let name = expect_bounded_string(
        take(&mut map, "name", path)?,
        &format!("{path}.name"),
        4_096,
    )?;
    if id.is_empty() {
        return Err(invalid("identity id must not be empty").at_path(format!("{path}.id")));
    }
    Ok(ProjectedIdentityV1 { id, name })
}

fn validate_schedule(value: SpannedValue) -> Result<ProjectedScheduleV1, CliError> {
    let span = value.span;
    let mut schedule = expect_mapping(value, "schedule", "schedule")?;
    expect_exact_keys(
        &schedule,
        &["start", "end", "timezone", "all_day"],
        span,
        "schedule",
    )?;
    let start = expect_bounded_string(
        take(&mut schedule, "start", "schedule")?,
        "schedule.start",
        128,
    )?;
    let end = expect_bounded_string(take(&mut schedule, "end", "schedule")?, "schedule.end", 128)?;
    let start_date = validate_rfc3339(&start, "schedule.start")?;
    let end_date = validate_rfc3339(&end, "schedule.end")?;
    if end_date <= start_date {
        return Err(invalid("schedule end must be later than start").at_path("schedule.end"));
    }
    let timezone = match take(&mut schedule, "timezone", "schedule")? {
        SpannedValue {
            value: Value::Null, ..
        } => None,
        value => {
            let timezone = expect_bounded_string(value, "schedule.timezone", 128)?;
            timezone.parse::<chrono_tz::Tz>().map_err(|_| {
                invalid("schedule timezone must be an IANA name").at_path("schedule.timezone")
            })?;
            Some(timezone)
        }
    };
    let all_day_node = take(&mut schedule, "all_day", "schedule")?;
    let all_day = match all_day_node.value {
        Value::Bool(value) => value,
        _ => {
            return Err(at_span(
                invalid("schedule all_day must be boolean").at_path("schedule.all_day"),
                all_day_node.span,
            ));
        }
    };
    Ok(ProjectedScheduleV1 {
        start,
        end,
        timezone,
        all_day,
    })
}

fn validate_rfc3339(value: &str, path: &str) -> Result<DateTime<chrono::FixedOffset>, CliError> {
    if !has_explicit_offset(value) {
        return Err(invalid("datetime must include an explicit RFC 3339 offset").at_path(path));
    }
    DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid("datetime must be valid RFC 3339").at_path(path))
}

fn has_explicit_offset(value: &str) -> bool {
    value.ends_with('Z')
        || value.get(10..).is_some_and(|tail| {
            tail.contains('+') || tail.rfind('-').is_some_and(|index| index > 0)
        })
}

fn expect_mapping(
    value: SpannedValue,
    path: &str,
    label: &str,
) -> Result<BTreeMap<String, SpannedValue>, CliError> {
    match value.value {
        Value::Mapping(values) => Ok(values),
        _ => Err(at_span(
            invalid(format!("{label} must be a mapping")).at_path(path),
            value.span,
        )),
    }
}

fn expect_exact_keys(
    values: &BTreeMap<String, SpannedValue>,
    expected: &[&str],
    span: Span,
    path: &str,
) -> Result<(), CliError> {
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if let Some(unknown) = values.keys().find(|key| !expected.contains(key.as_str())) {
        return Err(at_span(
            invalid(format!("unknown field '{unknown}'")).at_path(join_path(path, unknown)),
            values[unknown].span,
        ));
    }
    if let Some(missing) = expected.iter().find(|key| !values.contains_key(**key)) {
        return Err(at_span(
            invalid(format!("missing required field '{missing}'"))
                .at_path(join_path(path, missing)),
            span,
        ));
    }
    Ok(())
}

fn take(
    values: &mut BTreeMap<String, SpannedValue>,
    key: &str,
    path: &str,
) -> Result<SpannedValue, CliError> {
    values.remove(key).ok_or_else(|| {
        invalid(format!("missing required field '{key}'")).at_path(join_path(path, key))
    })
}

fn expect_bounded_string(
    value: SpannedValue,
    path: &str,
    maximum: usize,
) -> Result<String, CliError> {
    let span = value.span;
    let Value::String(value) = value.value else {
        return Err(at_span(
            invalid("value must be a string").at_path(path),
            span,
        ));
    };
    bounded_string(value, span, path, maximum)
}

fn bounded_string(
    value: String,
    span: Span,
    path: &str,
    maximum: usize,
) -> Result<String, CliError> {
    if value.len() > maximum {
        return Err(at_span(
            invalid(format!("string exceeds the {maximum}-byte limit")).at_path(path),
            span,
        ));
    }
    Ok(value)
}

fn join_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{parent}.{child}")
    }
}

fn invalid(message: impl Into<String>) -> CliError {
    CliError::new(CliErrorCode::MetaYamlInvalid, message)
}

fn at_span(mut error: CliError, span: Span) -> CliError {
    error.line = Some(span.line);
    error.column = Some(span.column);
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &str = r#"id: "page_1"
title: "Launch **plan**"
properties:
  "status":
    name: "Status"
    type: "select"
    value:
      id: "o_triage"
      name: "Triage"
  "p_score000":
    name: "Score"
    type: "number"
    value: 1.25
schedule:
  start: "2026-07-20T09:00:00+08:00"
  end: "2026-07-20T10:00:00+08:00"
  timezone: "Asia/Shanghai"
  all_day: false
"#;

    #[test]
    fn parses_typed_metadata_and_accepts_reordered_commented_input() {
        let first = parse(META.as_bytes()).expect("canonical-shaped metadata");
        let reordered = parse(
            br#"# formatting is not semantic
schedule:
  all_day: false
  timezone: "Asia/Shanghai"
  end: "2026-07-20T10:00:00+08:00"
  start: "2026-07-20T09:00:00+08:00"
properties:
  p_score000: { value: 1.25, type: number, name: Score }
  status:
    value: { name: Triage, id: o_triage }
    type: select
    name: Status
title: "Launch **plan**"
id: page_1
"#,
        )
        .expect("reordered metadata");

        assert_eq!(first, reordered);
        assert_eq!(
            first
                .properties
                .iter()
                .find(|property| property.property_id == "status")
                .expect("status Property")
                .value,
            ProjectedPropertyValueV1::Identity(ProjectedIdentityV1 {
                id: "o_triage".to_owned(),
                name: "Triage".to_owned(),
            })
        );
    }

    #[test]
    fn parses_canonical_page_key_and_keeps_it_read_only_in_drafts() {
        let base = parse(
            META.replace("title:", "page_key: \"LAB-13\"\ntitle:")
                .as_bytes(),
        )
        .expect("keyed metadata");
        assert_eq!(base.page_key.as_deref(), Some("LAB-13"));

        let changed = parse(
            META.replace("title:", "page_key: \"LAB-14\"\ntitle:")
                .as_bytes(),
        )
        .expect("changed keyed metadata");
        let error = compare_draft_metadata(&base, &changed)
            .expect_err("drafts cannot rewrite the Page key");
        assert_eq!(error.code, CliErrorCode::DraftReadOnlyFieldChanged);
        assert_eq!(error.path.as_deref(), Some("page_key"));

        let invalid = META.replace("title:", "page_key: \"lab-13\"\ntitle:");
        assert_eq!(
            parse(invalid.as_bytes())
                .expect_err("non-canonical key")
                .path
                .as_deref(),
            Some("page_key")
        );
    }

    #[test]
    fn parses_relation_summary_with_unavailable_target_counts() {
        let metadata = parse(
            br#"id: "page_1"
title: "Blocked task"
properties:
  "p_blocked0":
    name: "Blocked by"
    type: relation
    value:
      targets:
        - id: "page_visible"
          name: "Visible dependency"
      total_count: 3
      unavailable_count: 1
      has_more: true
schedule: null
"#,
        )
        .expect("Relation summary metadata");
        assert_eq!(
            metadata.properties[0].value,
            ProjectedPropertyValueV1::Relation(ProjectedRelationSummaryV1 {
                targets: vec![ProjectedIdentityV1 {
                    id: "page_visible".to_owned(),
                    name: "Visible dependency".to_owned(),
                }],
                total_count: 3,
                unavailable_count: 1,
                has_more: true,
            })
        );

        let inconsistent = br#"id: page
title: title
properties:
  p_blocked0:
    name: Blocked by
    type: relation
    value:
      targets: []
      total_count: 1
      unavailable_count: 0
      has_more: false
schedule: null
"#;
        assert!(parse(inconsistent).is_err());
    }

    #[test]
    fn rejects_duplicate_keys_aliases_tags_directives_and_documents() {
        let cases = [
            "id: page\nid: duplicate\ntitle: title\nproperties: {}\nschedule: null\n",
            "id: &page page\ntitle: *page\nproperties: {}\nschedule: null\n",
            "id: !thing page\ntitle: title\nproperties: {}\nschedule: null\n",
            "%YAML 1.2\n---\nid: page\ntitle: title\nproperties: {}\nschedule: null\n",
            "id: page\ntitle: title\nproperties: {}\nschedule: null\n---\nid: two\ntitle: title\nproperties: {}\nschedule: null\n",
        ];
        for input in cases {
            assert!(parse(input.as_bytes()).is_err(), "input must fail: {input}");
        }
    }

    #[test]
    fn rejects_alternate_numbers_and_type_mismatches() {
        for number in [".nan", ".inf", "0x10", "0o10", "01", "1_000", "+1"] {
            let input = META.replace("value: 1.25", &format!("value: {number}"));
            let error = parse(input.as_bytes()).expect_err("alternate number must fail");
            assert_eq!(error.code, CliErrorCode::MetaYamlInvalid);
        }

        let mismatch = META.replace("value: 1.25", "value: true");
        let error = parse(mismatch.as_bytes()).expect_err("number property must reject bool");
        assert_eq!(error.path.as_deref(), Some("properties.p_score000.value"));
    }

    #[test]
    fn draft_comparison_ignores_formatting_but_rejects_read_only_changes() {
        let base = parse(META.as_bytes()).expect("base");
        let mut title = base.clone();
        title.title_markdown = "Changed".to_owned();
        assert_eq!(
            compare_draft_metadata(&base, &title)
                .unwrap()
                .title
                .as_deref(),
            Some("Changed")
        );

        let mut property = base.clone();
        property
            .properties
            .iter_mut()
            .find(|property| property.property_id == "p_score000")
            .expect("p_score000 property")
            .value = ProjectedPropertyValueV1::Number(2.0);
        let error = compare_draft_metadata(&base, &property)
            .expect_err("read-only property change must fail");
        assert_eq!(error.code, CliErrorCode::DraftReadOnlyFieldChanged);
        assert_eq!(error.path.as_deref(), Some("properties.p_score000"));
    }

    #[test]
    fn enforces_byte_scalar_node_depth_property_and_sequence_bounds() {
        let oversized_document = vec![b' '; MAX_META_YAML_BYTES + 1];
        assert!(parse(&oversized_document).is_err());

        let oversized_scalar = format!(
            "id: page\ntitle: \"{}\"\nproperties: {{}}\nschedule: null\n",
            "x".repeat(MAX_META_YAML_SCALAR_BYTES + 1)
        );
        assert!(parse(oversized_scalar.as_bytes()).is_err());

        let mut deep = "id: page\ntitle: title\nproperties:\n  value:\n    name: value\n    type: multi_select\n    value:".to_owned();
        for _ in 0..=MAX_META_YAML_DEPTH {
            deep.push_str(" [");
        }
        for _ in 0..=MAX_META_YAML_DEPTH {
            deep.push(']');
        }
        deep.push_str("\nschedule: null\n");
        assert!(parse(deep.as_bytes()).is_err());

        let mut properties = "id: page\ntitle: title\nproperties:\n".to_owned();
        for index in 0..=MAX_META_YAML_PROPERTIES {
            properties.push_str(&format!(
                "  p{index}: {{ name: p, type: text, value: null }}\n"
            ));
        }
        properties.push_str("schedule: null\n");
        assert!(parse(properties.as_bytes()).is_err());

        let mut sequence = "id: page\ntitle: title\nproperties:\n  p:\n    name: p\n    type: multi_select\n    value:\n".to_owned();
        for index in 0..=MAX_META_YAML_SEQUENCE {
            sequence.push_str(&format!("      - {{ id: i{index}, name: n }}\n"));
        }
        sequence.push_str("schedule: null\n");
        assert!(parse(sequence.as_bytes()).is_err());

        let mut nodes = "id: page\ntitle: title\nproperties:\n".to_owned();
        for index in 0..MAX_META_YAML_NODES {
            nodes.push_str(&format!("  n{index}: {{}}\n"));
        }
        nodes.push_str("schedule: null\n");
        assert!(nodes.len() < MAX_META_YAML_BYTES);
        assert!(parse(nodes.as_bytes()).is_err());
    }
}
