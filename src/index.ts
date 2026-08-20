#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { createClientFromEnv, type BwClient } from './bw-client.js';
import { currentClient } from './request-context.js';
import { filterToolsByScope, hasScope, requiredScope } from './scopes.js';
import { bwGetAdso, bwCreateAdso, FieldDef, bwUpdateAdso, bwUpdateAdsoAddPureField, bwUpdateAdsoSettings, AdsoSettings, bwUpdateAdsoManageKeys, bwUpdateAdsoFieldProperties, FieldProperties } from './tools/adso.js';
import { bwGetInfoObject, bwCreateInfoObject, bwUpdateInfoObject, AttributeDef } from './tools/infoobject.js';
import { bwGetTransformation, bwUpdateTransformation, bwCreateTransformation, bwSetTransformationRuntime, bwSetTransformationRoutine, bwDeleteTransformationRoutine, bwSetTransformationRoutineFields, bwSetTransformationExpertRoutine } from './tools/transformation.js';
import { bwActivate } from './tools/activation.js';
import { bwSystemProfile } from './tools/system_profile.js';
import { bwReadMetadataTables } from './tools/metadata_tables.js';
import { bwGetDtps, bwGetDtp, bwCreateDtp, bwRunDtp, bwUpdateDtp, bwSetDtpFilterRoutine, bwUnlockDtp, DtpFilterSelectionInput } from './tools/dtp.js';
import { bwSearch, bwXref } from './tools/search.js';
import { bwDelete } from './tools/delete.js';
import { bwCreateInfoArea, bwMoveObject, bwGetInfoarea } from './tools/infoarea.js';
import { bwChangePackage, bwListChangeableTransports } from './tools/cto.js';
import { bwCreateInfosource, bwUpdateInfosource, bwGetInfosource, InfosourceField } from './tools/infosource.js';
import { bwPushData, bwGetPushSchema } from './tools/push.js';
import { bwGetQuery, bwCreateQuery } from './tools/query.js';
import { bwCreateVariable, CreateVariableArgs } from './tools/variable.js';
import { bwUpdateQueryLayout, bwUpdateQueryFilter, bwUpdateQueryKeyFigures, bwUpdateQuerySettings, LayoutOperation, FilterOperation, KeyFigureOperation, UpdateQuerySettingsArgs } from './tools/query_update.js';
import { bwUpdateQueryCharacteristic, UpdateQueryCharacteristicArgs } from './tools/query_characteristic.js';
import {
  bwGetCompositeProvider,
  bwCreateCompositeProvider,
  bwUpdateCompositeProviderInput,
  bwUpdateCompositeProviderMapping,
  bwUpdateCompositeProviderJoin,
  bwRemoveCompositeProviderJoin,
  bwUpdateCompositeProviderSettings,
} from './tools/composite_provider.js';
import { bwUpdateCompositeProvider, CompositeProviderFieldAction } from './tools/composite_provider_update.js';
import { bwGetCkf, bwGetRkf, bwGetStructure } from './tools/cp_components.js';
import { bwCreateRkf, CreateRkfArgs } from './tools/rkf_create.js';
import { bwListContents } from './tools/repository.js';
import { bwListSourceSystems, bwListDatasources, bwGetSourceSystem, bwGetDatasource, bwPreviewDatasource, bwListRemoteEntities, bwCreateDatasource, bwChangeDatasourceDelta, bwSetDatasourceFields } from './tools/datasource.js';
import { bwGetDataflow } from './tools/dataflow.js';
import { bwQueryData, bwGetFilterValues, InfoObjectState, VariableInput, DrillOperation } from './tools/reporting.js';
import { bwGetRoles, bwGetQueryRoles, bwSetQueryRoles, bwGetRoleQueries } from './tools/roles.js';
import { bwGetProcessChain } from './tools/processchain.js';
import { bwGetProcessVariant } from './tools/processvariant.js';
import { bwListRequests, bwGetRequest, bwActivateRequest } from './tools/request_monitor.js';
import {
  bwListRemodelingRequests,
  bwGetRemodelingRequest,
  bwRunRemodeling,
  type RemodelingAction,
} from './tools/remodeling.js';
import { bwGetOpenHub } from './tools/openhub.js';
import {
  bwGetAggregationLevel,
  bwCreateAggregationLevel,
  bwUpdateAggregationLevelFields,
  AggregationLevelFieldAction,
  bwGetPlanningProperties,
  bwGetPlanningSequence,
  bwGetPlanningFunction,
} from './tools/planning.js';
import { bwListProcessChainRuns, bwGetProcessChainRunDetail, bwListProcessChainLastStatus } from './tools/process_chain_monitor.js';
import { bwCreateProcessChain, bwUpdateProcessChain, bwActivateProcessChain, bwAddProcessChainErrorLinks, bwSwapProcessChainDtp, bwAppendProcessChainDtp, bwAddProcessChainProgram, bwAddProcessChainEdge, bwRemoveProcessChainEdge, bwRemoveProcessChainStep, bwCreateDecisionVariant, CreateProcessChainParams, UpdateProcessChainParams, EdgeDef, EdgeStatus, TriggerEventConfig } from './tools/processchain_write.js';
import { bwCreateTransportTask } from './tools/transport.js';

// Map the snake_case trigger_event tool argument to the TriggerEventConfig shape.
function mapTriggerEvent(raw: unknown): TriggerEventConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  if (e['event_id'] === undefined) return undefined;
  return {
    eventId: e['event_id'] as string,
    eventParameter: e['event_parameter'] as string | undefined,
    eventType: e['event_type'] as string | undefined,
    onlyOnce: e['only_once'] as boolean | undefined,
  };
}

// Map one process-chain step from the tool's snake_case schema onto the builder's step
// model. Shared by bw_create_process_chain and bw_update_process_chain so both accept the
// same step types. An ABAP step's SE38 selection variant arrives as program_variant,
// because the step-level "variant" field already names the DECISION variant.
function mapChainStep(s: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { id: s['id'], type: s['type'] };
  const copy = (from: string, to = from) => {
    if (s[from] !== undefined) base[to] = s[from];
  };
  copy('dtp');
  copy('variant');
  copy('description');
  copy('datastores');
  copy('requestsSequential');
  copy('errorOnNonActivation');
  copy('remDatastores');
  copy('object');
  copy('program');
  copy('program_variant', 'variant');
  copy('program_package', 'programPackage');
  copy('program_description', 'programDescription');
  copy('variant_description', 'variantDescription');
  copy('synchronous');
  copy('local');
  return base;
}

// Filter properties shared by bw_create_dtp and bw_update_dtp. The selection of a field is
// always written as a whole: repeated calls replace it, they do not add to it.
const DTP_FILTER_SCHEMA_PROPS = {
  filter_field: {
    type: 'string',
    description:
      'Filter field to set. Use the exact field name from bw_get_dtp; a name that does not ' +
      'exist is rejected. Requires filter_value or filter_selections.',
  },
  filter_value: {
    type: 'string',
    description:
      'One or more values for an Equal selection, comma-separated (e.g. "VAL1,VAL2,VAL3"). ' +
      'REPLACE semantics: the list is the complete selection of that field, so pass all values ' +
      'in one call. An empty string selects the BW initial value (not the literal "#"). ' +
      'For ranges, patterns, exclusions or values containing a comma, use filter_selections. ' +
      'Look values up with bw_get_filter_values first — a wrong value activates cleanly and ' +
      'filters everything away.',
  },
  filter_excluding: {
    type: 'boolean',
    description:
      'If true, all values of filter_value are excluded instead of included. Default false. ' +
      'Applies to filter_value only; filter_selections carries a sign per entry.',
  },
  filter_selections: {
    type: 'array',
    description:
      'Full selection vocabulary for one filter field, equivalent to an ABAP RANGE table. ' +
      'REPLACE semantics like filter_value, and mutually exclusive with it. Each entry is ' +
      'validated against the operators the field itself publishes, so an unsupported operator ' +
      'is an error instead of a silently ignored setting.',
    items: {
      type: 'object',
      properties: {
        operator: {
          type: 'string',
          enum: ['Equal', 'NotEqual', 'Between', 'ContainsPattern', 'GreaterThan', 'GreaterEqual', 'LessThan', 'LessEqual'],
          description:
            'Selection operator (default "Equal"). RANGE equivalents: EQ = Equal, NE = NotEqual, ' +
            'BT = Between, CP = ContainsPattern (use "*" as the wildcard), GT/GE/LT/LE = the ' +
            'comparison operators. The comparison operators are include-only on the fields seen ' +
            'so far; the field metadata decides.',
        },
        sign: {
          type: 'string',
          enum: ['I', 'E'],
          description: 'I = include (default), E = exclude. Includes and excludes may be mixed on one field.',
        },
        low: {
          type: 'string',
          description: 'Value, lower bound (Between) or pattern (ContainsPattern). Empty string = BW initial value.',
        },
        high: {
          type: 'string',
          description: 'Upper bound. Only for operator "Between", where it is mandatory.',
        },
      },
      required: ['low'],
    },
  },
} as const;

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
    {
      name: 'bw_search',
      description:
        'Universal search for BW objects by name or description. Use this whenever the user wants to find, list, or look up any BW object — aDSOs, queries (ELEM), transformations (TRFN), DTPs (DTPA), InfoObjects (IOBJ), InfoSources (TRCS), CompositeProviders (HCPR), DataSources (RSDS), InfoAreas (AREA), process chains (RSPC), and any other TLOGO type. ' +
        'Supports wildcards (e.g. "Z*" to find all objects starting with Z). ' +
        'Pass object_type to restrict results to a single type; omit it to search across all types. ' +
        'Prefer this tool over type-specific get/list tools whenever the object name is unknown or a pattern is given.',
      inputSchema: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Search string. Wildcards supported: * matches any sequence, ? matches a single character. Example: "Z*" finds all objects whose name starts with Z.',
          },
          object_type: {
            type: 'string',
            description:
              'Optional TLOGO filter to restrict results to one object type. Common values: ADSO (aDSO), ELEM (BEx/BW query), TRFN (transformation), DTPA (DTP), IOBJ (InfoObject), TRCS (InfoSource), HCPR (CompositeProvider), RSDS (DataSource), AREA (InfoArea), RSPC (process chain). Leave empty to search all types.',
          },
        },
        required: ['search_term'],
      },
    },
    {
      name: 'bw_xref',
      description:
        'Find where-used / dependencies for a BW object. Returns all objects that reference the given object. ' +
        'Use this to find the Transformation and DTPs that reference an aDSO, or to find which DTPs depend on a Transformation. ' +
        'Use object_type=DTPA to find the process chain(s) a DTP belongs to — this is preferred over bw_get_dtp when only the process chain is needed.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type: ADSO, TRFN, DTPA, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "ADSO_NAME" or "TRFN_UUID_KEY").',
          },
          source_system: {
            type: 'string',
            description: 'Required for object_type "RSDS". Logical source system name (e.g. "LSYS_NAME"). The correct padded objectName is built automatically.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_adso',
      description:
        'Read an aDSO (Advanced DataStore Object) structure — fields, settings, version.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO name (e.g. "ADSO_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_create_adso',
      description:
        'Create a new aDSO shell. ' +
        'action "from_template" (default): proposes fields/keys/settings from a template object — pass template_name. Without template_name creates an empty standard shell. ' +
        'The template can be an existing aDSO (template_type "ADSO", default) or a DataSource (template_type "RSDS"); for RSDS, source_system is required and the server proposes the DataSource fields. ' +
        'action "empty": creates a minimal empty aDSO with the given adso_type preset (no fields). ' +
        'After creation the aDSO is inactive — add fields with bw_update_adso, then call bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'Name for the new aDSO (e.g. "ADSO_NAME").',
          },
          label: {
            type: 'string',
            description: 'Description / label for the new aDSO.',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to create the aDSO in (e.g. "NEXTJUICE").',
          },
          action: {
            type: 'string',
            enum: ['from_template', 'empty'],
            description: '"from_template" (default) or "empty".',
          },
          template_name: {
            type: 'string',
            description: 'Template object to propose fields from (action "from_template" only). An aDSO name when template_type is "ADSO", or a DataSource name when template_type is "RSDS".',
          },
          template_type: {
            type: 'string',
            enum: ['ADSO', 'RSDS'],
            description: 'Type of the template object for action "from_template": "ADSO" (default) to copy from an existing aDSO, or "RSDS" to propose fields from a DataSource. When "RSDS", source_system is required.',
          },
          source_system: {
            type: 'string',
            description: 'Source system name of the DataSource. Required when template_type is "RSDS".',
          },
          adso_type: {
            type: 'string',
            enum: ['standard', 'staging_inbound_only', 'staging_compress', 'staging_reporting', 'datamart', 'direct_update'],
            description: 'aDSO type preset for action "empty" (default "standard").',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          write_interface: {
            type: 'boolean',
            description: 'Enable write interface (pushMode="true"). Default false.',
          },
        },
        required: ['adso_name', 'label', 'info_area'],
      },
    },
    {
      name: 'bw_update_adso',
      description:
        'Add/remove fields, change aDSO type/settings, manage key fields, or update individual field properties. ' +
        'action "add_field" (default): add one or more InfoObject-backed fields — infoobject_name required. ' +
        'action "remove_field": removes the field from the aDSO (and from the key if it was a key field). ' +
        'action "add_pure_field": add one or more pure (non-InfoObject) fields — pass fields array with name, label, data_type, optional length/precision/scale/aggregation_behavior/is_key. ' +
        'action "update_settings": change aDSO type preset and/or individual boolean flags — no infoobject_name needed. ' +
        'action "manage_keys": replace the complete key field list — pass key_fields array (empty = no key fields). ' +
        'action "update_field_properties": modify sidDeterminationMode, aggregationBehavior, fixedCurrency/Unit, a unit/currency field reference (unit_currency_field), the field group (dimension), or descriptions of a single field — pass field_name and properties. ' +
        'Field groups: pass "dimension" on add_field/add_pure_field to place new fields in the right group straight away — a field added without it lands in the catch-all group and moving it afterwards costs a second activation. ' +
        'Returns a lock_handle that must be passed to bw_activate to complete the operation. ' +
        'Sequence: bw_update_adso → bw_activate (adso) → bw_activate (trfn) → bw_activate (each dtpa).',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO name (e.g. "ADSO_NAME").',
          },
          infoobject_name: {
            type: 'string',
            description: 'InfoObject name or comma-separated list to add or remove (e.g. "IOBJ_NAME" or "IOBJ_A,IOBJ_B"). Required for add_field and remove_field.',
          },
          action: {
            type: 'string',
            enum: ['add_field', 'remove_field', 'add_pure_field', 'update_settings', 'manage_keys', 'update_field_properties'],
            description: '"add_field" (default), "remove_field", "add_pure_field", "update_settings", "manage_keys", or "update_field_properties".',
          },
          fields: {
            type: 'array',
            description: 'Pure field definitions for action "add_pure_field".',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (uppercase).' },
                label: { type: 'string', description: 'Field description.' },
                data_type: { type: 'string', description: 'Data type (user-facing names). Fixed length, do not pass length: INT1, INT2, INT4, INT8, FLTP, DATS, TIMS, LANG, CUKY, UNIT, DF16_RAW. No length: CURR, QUAN, STRING, RAWSTRING. User-defined length: CHAR, NUMC, RAW, SSTRING. User-defined length+precision: DEC. Precision only: DF16_DEC, DF34_DEC. Fixed length: D16N (16), D34N (34).' },
                length: { type: 'number', description: 'Length for character types (CHAR, NUMC).' },
                precision: { type: 'number', description: 'Total digits. For DEC (required) and, optionally, for CURR/QUAN (total length, default 17 when only scale is given).' },
                scale: { type: 'number', description: 'Decimal places. Required for CURR/QUAN (> 0 — BW rejects scale 0) and used for DEC. Emitted as the XML scale attribute.' },
                aggregation_behavior: { type: 'string', enum: ['SUM', 'MIN', 'MAX', 'AVG', 'LAST', 'NONE'], description: 'Aggregation (default SUM for numeric types). Use NONE for no aggregation.' },
                is_key: { type: 'boolean', description: 'If true, also injects a <keyElement> entry.' },
                dimension: { type: 'string', description: 'Field group ("Feldgruppe") to place the field in, given as the bare group name — e.g. "__KEYFIGURES" for the key figure group or "ALL" for the catch-all. Must be a group the aDSO declares; an unknown name is rejected with the declared groups listed rather than silently falling back. Read the current assignment from the DIM column of bw_get_adso.' },
              },
              required: ['name', 'label', 'data_type'],
            },
          },
          field_name: {
            type: 'string',
            description: 'Field name to modify (only for action "update_field_properties"), e.g. "FIELD_NAME" or "AMOUNT_P".',
          },
          properties: {
            type: 'object',
            description: 'Field properties to update (only for action "update_field_properties").',
            properties: {
              sid_determination_mode: {
                type: 'string',
                enum: ['N', 'R', 'S', 'M'],
                description: 'Master data check mode (InfoObject-backed fields only). N=none, R=reporting only, S=load/activate, M=load+SID.',
              },
              local_description: {
                description: 'Local description override (InfoObject-backed). String to override, null to clear (revert to InfoObject text).',
              },
              aggregation_behavior: {
                type: 'string',
                enum: ['SUM', 'MIN', 'MAX', 'AVG', 'LAST', 'NONE'],
                description: 'Aggregation behavior (pure fields only). Use NONE for no aggregation.',
              },
              fixed_currency: {
                description: 'Fixed currency code (pure CURR fields). String to set, null to switch to dynamic currency.',
              },
              fixed_unit: {
                description: 'Fixed unit of measure (pure QUAN fields). String to set, null to switch to dynamic unit.',
              },
              unit_currency_field: {
                description:
                  'Unit/currency FIELD reference for a pure QUAN/CURR field: the name of another field in the same aDSO ' +
                  'that supplies the unit or currency (sets <unitCurrencyElement>#///FIELD</unitCurrencyElement>). ' +
                  'Use this instead of fixed_unit/fixed_currency to fill the unit/currency dynamically from a field ' +
                  '(the referenced field must be a UNIT or CUKY field). Any fixed_unit/fixed_currency is removed. ' +
                  'null removes the reference. Example: on "QUANTITY" set unit_currency_field="QUANTITYUNIT".',
              },
              description: {
                type: 'string',
                description: 'Description label for pure fields (sets <localProperties><descriptions label="..."/>).',
              },
              dimension: {
                type: 'string',
                description: 'Field group ("Feldgruppe") to place the field in, given as the bare group name — e.g. "__KEYFIGURES" for the key figure group or "ALL" for the catch-all. Must be a group the aDSO declares; an unknown name is rejected with the declared groups listed rather than silently falling back. Read the current assignment from the DIM column of bw_get_adso. Moves the field between groups without touching any other property.',
              },
            },
          },
          key_fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of field names that should be key fields (only for action "manage_keys"). Empty array removes all key fields.',
          },
          settings: {
            type: 'object',
            description: 'Settings to apply (only for action "update_settings").',
            properties: {
              adso_type: {
                type: 'string',
                enum: ['standard', 'staging_inbound_only', 'staging_compress', 'staging_reporting', 'datamart', 'direct_update'],
                description: 'aDSO type preset. Sets activateData, cubeDeltaOnly, directUpdate, isReportingObject, noAqDeletion.',
              },
              write_changelog: { type: 'boolean', description: 'Write change log (Standard type sub-option).' },
              snap_shot_scenario: { type: 'boolean', description: 'Snapshot support (Standard type sub-option).' },
              unique_data_records: { type: 'boolean', description: 'Unique records (Standard type sub-option).' },
              planning_mode: { type: 'boolean', description: 'Planning enabled.' },
              write_interface: { type: 'boolean', description: 'Enable or disable write interface (pushMode).' },
              label: { type: 'string', description: 'aDSO description text.' },
            },
          },
          dimension: {
            type: 'string',
            description: 'Field group ("Feldgruppe") to place the field in, given as the bare group name — e.g. "__KEYFIGURES" for the key figure group or "ALL" for the catch-all. Must be a group the aDSO declares; an unknown name is rejected with the declared groups listed rather than silently falling back. Read the current assignment from the DIM column of bw_get_adso. Applies to every field added by this call (action "add_field").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_create_infoobject',
      description:
        'Create a new InfoObject — Characteristic (CHA) or Key Figure (KYF) — inactive. ' +
        'Sequence: lock → POST create → unlock. ' +
        'After creation call bw_activate with object_type "iobj" to activate.',
      inputSchema: {
        type: 'object',
        properties: {
          infoobject_type: {
            type: 'string',
            enum: ['CHA', 'KYF'],
            description: 'InfoObject type: CHA (Characteristic) or KYF (Key Figure). Default "CHA".',
          },
          name: {
            type: 'string',
            description: 'InfoObject name, max 9 characters (e.g. "IOBJ_NAME").',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to assign the InfoObject to (e.g. "NEXTJUICE").',
          },
          description: {
            type: 'string',
            description: 'Short and long description text.',
          },
          // CHA-specific
          data_type: {
            type: 'string',
            enum: ['CHAR', 'NUMC', 'DATS', 'TIMS', 'SNUMC'],
            description: 'CHA only. ABAP data type. Default "CHAR".',
          },
          length: {
            type: 'number',
            description: 'CHA only. Field length. Default 10.',
          },
          conversion_routine: {
            type: 'string',
            description: 'CHA only. Conversion routine (e.g. "ALPHA"). Default "ALPHA" for CHAR/NUMC, "" for others.',
          },
          with_master_data: {
            type: 'boolean',
            description: 'CHA only. Generate master data tables. Default false.',
          },
          with_texts: {
            type: 'boolean',
            description: 'CHA only. Generate text tables. Default false.',
          },
          referenced_infoobject: {
            type: 'string',
            description: 'CHA only. Reference to an existing InfoObject (e.g. "IOBJ_NAME"). Omit withMasterData/withTexts — they are inherited. Default "".',
          },
          compound_infoobjects: {
            type: 'array',
            items: { type: 'string' },
            description: 'Technical names of the compound parent InfoObjects, in order. CHA only. Example: ["COMPND_IOBJ_NAME"].',
          },
          // KYF-specific
          object_specific_data_type: {
            type: 'string',
            enum: ['DEC', 'CURR', 'FLTP', 'QUAN', 'DATS', 'INT4', 'INT8', 'TIMS'],
            description: 'KYF only. Data type. Default "DEC". keyfigureType and semantics are derived automatically.',
          },
          aggregation_type: {
            type: 'string',
            enum: ['SUM', 'MAX', 'MIN'],
            description: 'KYF only. Aggregation type. Default "SUM".',
          },
          fixed_unit: {
            type: 'string',
            description: 'Fixed unit of measure for QUAN key figures (e.g. "KWH", "M3"). Required when object_specific_data_type is QUAN.',
          },
          fixed_currency: {
            type: 'string',
            description: 'Fixed currency for CURR key figures (e.g. "EUR"). Required when object_specific_data_type is CURR.',
          },
          // common
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['name', 'info_area', 'description'],
      },
    },
    {
      name: 'bw_create_infoarea',
      description:
        'Create a new InfoArea. The InfoArea is immediately active after creation — no activation step needed.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoArea name, max 12 characters (e.g. "NEXTJUICE").',
          },
          parent_info_area: {
            type: 'string',
            description: 'Parent InfoArea name. Omit to create at root level.',
          },
          description: {
            type: 'string',
            description: 'Description text for the InfoArea.',
          },
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_transformation',
      description:
        'Create a new Transformation between two BW objects (aDSO, DataSource, InfoSource, etc.). ' +
        'The Transformation name is server-generated (32-char UUID-like key). ' +
        'Created inactive — call bw_activate with object_type "trfn" afterwards.',
      inputSchema: {
        type: 'object',
        properties: {
          source_object_type: {
            type: 'string',
            description: 'Source object type. Valid values: HCPR (CompositeProvider), ADSO (aDSO), RSDS (DataSource — requires source_system), HAAP (HANA Analysis Process), IOBJ (InfoObject), TRCS (InfoSource), QVIW (Query).',
          },
          source_object_name: {
            type: 'string',
            description: 'Technical name of the source object.',
          },
          target_object_type: {
            type: 'string',
            description: 'Target object type. Valid values: ADSO (aDSO), IOBJ (InfoObject), TRCS (InfoSource), DEST (Open Hub Destination).',
          },
          target_object_name: {
            type: 'string',
            description: 'Technical name of the target object.',
          },
          package: {
            type: 'string',
            description: 'Development package. Default "$TMP".',
          },
          source_system: {
            type: 'string',
            description: 'Source system name. Required when source_object_type is RSDS (DataSource).',
          },
          copy_from_transformation: {
            type: 'string',
            description: 'Technical name of an existing Transformation to copy rules from.',
          },
          source_object_subtype: {
            type: 'string',
            description: 'InfoObject sub-type of the source. Only applies when source_object_type is IOBJ. Valid values: TEXT (text table), ATTR (attributes / master data), HIER (hierarchy).',
          },
          target_object_subtype: {
            type: 'string',
            description: 'InfoObject sub-type of the target. Only applies when target_object_type is IOBJ. Valid values: TEXT (text table), ATTR (attributes / master data), HIER (hierarchy).',
          },
        },
        required: ['source_object_type', 'source_object_name', 'target_object_type', 'target_object_name'],
      },
    },
    {
      name: 'bw_move_object',
      description:
        'Move a BW object (aDSO, InfoObject, InfoArea, …) to a different InfoArea. ' +
        'Single POST operation — no lock/unlock needed.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'BW object type URL segment (e.g. "adso", "iobj", "area").',
          },
          object_name: {
            type: 'string',
            description: 'Technical name of the object to move (e.g. "OBJECT_NAME").',
          },
          target_info_area: {
            type: 'string',
            description: 'Technical name of the target InfoArea (e.g. "MCPBW").',
          },
        },
        required: ['object_type', 'object_name', 'target_info_area'],
      },
    },
    {
      name: 'bw_change_package',
      description:
        'Assign an existing BW object to a different package (Development Class) and record the change on a transport request. ' +
        'Single write, no activation and no version change: this is a pure TADIR/transport assignment, so an active object stays active and no re-activation is required (verified for ADSO, TRFN, DTPA). Do not re-activate a TRFN afterwards — an activation with a stale lock can regenerate the AMDP method body. ' +
        'For object_type "RSDS" (DataSource) source_system is mandatory — the key is compound and the package change is verified by re-reading the DataSource. ' +
        'Verified for TRFN and RSDS; other TLOGO types use the same mechanism but are not trace-verified.',
      inputSchema: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'Technical name of the object to reassign (e.g. "OBJECT_NAME").',
          },
          object_type: {
            type: 'string',
            description: 'BW object type / TLOGO, e.g. "TRFN", "ADSO", "IOBJ", "TRCS", "RSDS", "HCPR".',
          },
          package: {
            type: 'string',
            description: 'Target package / Development Class (e.g. "Z_PACKAGE").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Required on systems with transport obligation.',
          },
          source_system: {
            type: 'string',
            description: 'Source system — required only for object_type "RSDS" (a DataSource is identified by DataSource name plus source system).',
          },
        },
        required: ['object_name', 'object_type', 'package'],
      },
    },
    {
      name: 'bw_list_changeable_transports',
      description:
        'List transport requests and their tasks via the BW transport state (cto/check). ' +
        'Defaults to the caller\'s modifiable requests. Use this to find an open request to assign an object to.',
      inputSchema: {
        type: 'object',
        properties: {
          own_only: {
            type: 'boolean',
            description: 'Only the caller\'s own requests (default true). false widens to all users.',
          },
          modifiable_only: {
            type: 'boolean',
            description: 'Only modifiable requests, i.e. status "D" (default true). false also returns released requests.',
          },
          include_objects: {
            type: 'boolean',
            description: 'Include the objects contained in each task (default false).',
          },
        },
      },
    },
    {
      name: 'bw_get_infoobject',
      description:
        'Read an InfoObject definition (must already exist in the system). Returns the full XML including data type, length, conversion routine, and descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          infoobject_name: {
            type: 'string',
            description: 'InfoObject name (e.g. "IOBJ_NAME").',
          },
        },
        required: ['infoobject_name'],
      },
    },
    {
      name: 'bw_update_infoobject',
      description:
        'Update a Characteristic InfoObject: change description and/or replace the attribute list. ' +
        'Replaces all existing attributes with the supplied list (pass an empty array to remove all). ' +
        'Also supports Key Figure (KYF) updates: set fixed_unit or fixed_currency. ' +
        'Sequence: lock → GET → PUT → activate → unlock — all in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoObject name (e.g. "IOBJ_NAME").',
          },
          description: {
            type: 'string',
            description: 'New short and long description text. Omit to keep existing.',
          },
          transport: {
            type: 'string',
            description: 'Workbench transport order number (e.g. "DEVK900000"). Required when object is in a non-local package.',
          },
          fixed_unit: {
            type: 'string',
            description: 'KYF only. Fixed unit of measure (e.g. "KWH", "M3"). Sets fixedUnit on a QUAN key figure.',
          },
          fixed_currency: {
            type: 'string',
            description: 'KYF only. Fixed currency (e.g. "EUR"). Sets fixedCurrency on a CURR key figure.',
          },
          attributes: {
            type: 'array',
            description: 'New attribute list. Omit or pass [] to remove all attributes.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Technical name of the referenced InfoObject (e.g. "ATTR_IOBJ_NAME").' },
                type: { type: 'string', enum: ['DIS', 'NAV'], description: 'Attribute type: DIS (Display) or NAV (Navigation).' },
                time_dependent: { type: 'boolean', description: 'Time-dependent attribute (NAV only, default false).' },
                display_in_query: { type: 'boolean', description: 'Display in query (default true).' },
                use_text_of_original_characteristic: { type: 'boolean', description: 'Use text of original characteristic (default true).' },
              },
              required: ['name', 'type'],
            },
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_transformation',
      description:
        'Read a Transformation structure — source/target segments, mapping rules. ' +
        'Transformation names are UUID-like generated keys (e.g. "TRFN_UUID_KEY"). ' +
        'Use bw_xref on the aDSO to find the transformation name.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key, e.g. "TRFN_UUID_KEY").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['transformation_name'],
      },
    },
    {
      name: 'bw_update_transformation',
      description:
        'Map a source field to a target InfoObject in a Transformation, or convert an existing rule to a field routine (StepRoutine) or formula rule (StepFormula). ' +
        'rule_type="direct" (default): changes a StepNoUpdate/StepInitial rule to StepDirect. ' +
        'rule_type="routine": converts an existing StepDirect, StepInitial, or StepNoUpdate rule to StepRoutine (AMDP field routine). ' +
        'rule_type="formula": converts an existing rule to StepFormula — no ABAP class generated, BW evaluates the formula natively. ' +
        'rule_type="constant": sets a fixed constant value on the target field — no source field needed. ' +
        'For routine/formula on StepNoUpdate rules, source_field is required. ' +
        'For routine/formula on StepDirect/StepInitial rules, source_field is ignored (field is already mapped). ' +
        'source_field is always ignored for rule_type="constant". ' +
        'rule_type="direct" with unit_source_field set: creates a COMBINED key-figure + unit/currency ' +
        'direct rule (multi-source/target) — maps a quantity together with its unit (or an amount with ' +
        'its currency) in one rule, as the Eclipse rule editor shows it. ' +
        'Returns a lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          source_field: {
            type: 'string',
            description:
              'Source field name in the source segment (e.g. "FIELD_NAME"). ' +
              'Required for rule_type="direct" if the existing rule has no source mapping. ' +
              'Also required for routine/formula when the target has no source mapping yet (StepNoUpdate). ' +
              'Required for rule_type="lookup".',
          },
          target_infoobject: {
            type: 'string',
            description: 'Target InfoObject name in the target segment (e.g. "IOBJ_NAME").',
          },
          rule_type: {
            type: 'string',
            enum: ['direct', 'routine', 'formula', 'constant', 'lookup', 'no_update'],
            description:
              'Rule type to assign. "direct" (default): maps source field directly (StepDirect). ' +
              '"routine": converts the rule to an AMDP field routine (StepRoutine) — the server generates the ABAP class automatically. ' +
              '"formula": converts the rule to a formula rule (StepFormula) — requires the formula parameter. ' +
              '"constant": sets a fixed constant value (StepConstant) — requires the constant_value parameter, source_field is ignored. ' +
              '"lookup": converts the rule to a StepRead (Lookup) rule — requires lookup_object and lookup_object_type. ' +
              '"no_update": reverts any existing mapping back to StepNoUpdate (no mapping, field stays empty). ' +
              'IMPORTANT: AMDP SQLSCRIPT methods only allow ASCII 7-bit characters — no German umlauts or special symbols in code or comments.',
          },
          formula: {
            type: 'string',
            description:
              'Formula expression for rule_type="formula" (required). ' +
              'Source fields are referenced by their technical field name: use /BIC/FIELDNAME for custom InfoObjects (e.g. "/BIC/FIELD_NAME + 10"), ' +
              'or the direct field name for standard InfoObjects. ' +
              'Operators: +, -, *, /. Functions: IF, ABS, CONCATENATE, DATE_YEAR, etc. ' +
              'Comparison operators < > <= >= <> are supported (will be XML-escaped automatically).',
          },
          constant_value: {
            type: 'string',
            description:
              'Constant value for rule_type="constant" (required). ' +
              'The value is written as-is into the target field during data loading. ' +
              'Example: "X" for a flag field, "USD" for a currency field.',
          },
          lookup_object: {
            type: 'string',
            description: 'Name of the InfoObject or aDSO to read from (Nachlese-Objekt). Required for rule_type="lookup".',
          },
          lookup_object_type: {
            type: 'string',
            enum: ['IOBJ', 'ADSO'],
            description: 'Type of the lookup object. "IOBJ" for InfoObject, "ADSO" for aDSO. Required for rule_type="lookup".',
          },
          additional_source_fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Additional source fields for rule_type="formula" when the formula references more than one source field. ' +
              'Combined with source_field, all listed fields are registered as inputs on the StepFormula rule. ' +
              'Example: ["QUANTITY_SOLD", "COST_PER_UNIT"].',
          },
          unit_source_field: {
            type: 'string',
            description:
              'Source unit/currency field for a COMBINED key-figure + unit/currency direct rule (rule_type="direct"). ' +
              'When set, target_infoobject is the key figure and this is the source field that fills its unit or currency. ' +
              'The target unit/currency field is derived automatically from the key figure\'s unit reference in the aDSO ' +
              '(the target key figure must reference a unit/currency field). The standalone unit/currency rule is folded ' +
              'into the combined rule and the transformation\'s currency/unit handling is switched on. ' +
              'Example: target_infoobject="QUANTITY", unit_source_field="QUANTITYUNIT".',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'target_infoobject'],
      },
    },
    {
      name: 'bw_delete_transformation_routine',
      description:
        'Remove a Start, End, or Expert routine from a Transformation. ' +
        "Removes the matching routine rule from the transformation's global routine group. " +
        'If no rules remain, removes the entire group. ' +
        'Returns lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          routine_type: {
            type: 'string',
            enum: ['start', 'end', 'expert'],
            description: 'Routine to remove: "start", "end", or "expert".',
          },
        },
        required: ['transformation_name', 'routine_type'],
      },
    },
    {
      name: 'bw_set_transformation_routine',
      description:
        'Add a Start, End, or Expert routine to a Transformation. ' +
        'Creates the global routine group (group id="0") and ABAP/AMDP method stub. ' +
        'Returns lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          routine_type: {
            type: 'string',
            enum: ['start', 'end', 'expert'],
            description: '"start" → GLOBAL_START, "end" → GLOBAL_END, "expert" → GLOBAL_EXPERT.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'routine_type'],
      },
    },
    {
      name: 'bw_set_transformation_expert_routine',
      description:
        'Write the CODE of an existing Start/End/Expert routine into the Transformation MASTER so it ' +
        'survives TLOGO regeneration — a full bw_activate(trfn) AND a transport import — then activate. ' +
        'Use this instead of abap-adt WriteSource on the generated /BIC/<uuid>_M class: WriteSource ' +
        'updates only the generated class body, which BW re-generates from the old master on the next ' +
        'trfn activation or transport import (symptom: "return type mismatch … OUTTAB[…]"). ' +
        'This tool replicates the Eclipse editor: it writes the class, then re-saves the transformation ' +
        'master and runs a TLOGO activation via the BW modeling endpoints. ' +
        'The routine must already exist (create it first with bw_set_transformation_routine). ' +
        'Activates automatically — no separate bw_activate needed.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          source: {
            type: 'string',
            description:
              'The complete routine method block: "METHOD <NAME> BY DATABASE PROCEDURE … ENDMETHOD." ' +
              'for AMDP (HANA) routines, or "METHOD <NAME> … ENDMETHOD." for ABAP routines — the same ' +
              'block shape abap-adt WriteSource(method=…) expects. AMDP SQLSCRIPT must be 7-bit ASCII ' +
              '(no umlauts / no <=). If omitted, the generated class is left untouched and only the ' +
              'master re-save + activation runs (to commit code already edited on the class).',
          },
          routine_type: {
            type: 'string',
            enum: ['start', 'end', 'expert'],
            description:
              '"expert" → GLOBAL_EXPERT (default), "start" → GLOBAL_START, "end" → GLOBAL_END. ' +
              'Selects the generated method name.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Required if the BW system requires transport assignment.',
          },
          class_name: {
            type: 'string',
            description:
              'Optional override for the generated class name (e.g. "/BIC/<uuid>_M"). ' +
              'Defaults to the class derived from the transformation. Use for non-standard/field routines.',
          },
          method_name: {
            type: 'string',
            description:
              'Optional override for the routine method name (e.g. a field-routine method). ' +
              'Defaults to GLOBAL_<ROUTINE_TYPE>. When set, the routine-exists guard is skipped.',
          },
        },
        required: ['transformation_name'],
      },
    },
    {
      name: 'bw_set_transformation_routine_fields',
      description:
        'Edit the list of target fields the global END routine writes ("Felder setzen" in SAP GUI). ' +
        'Requires an existing END routine — use bw_set_transformation_routine to create one first. ' +
        'Provide exactly one of: fields (explicit complete set of target fields the END routine should write) ' +
        'or exclude_fields (all target fields minus these). ' +
        'Rejected if neither or both are given, if any field name does not exist in the target segment, ' +
        'or if the resolved field set is empty. ' +
        'Does not activate. Returns lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Explicit complete set of target field names the END routine should write ' +
              '(e.g. ["FIELD_A", "FIELD_B"]). Case-insensitive. ' +
              'Mutually exclusive with exclude_fields.',
          },
          exclude_fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Target fields to exclude from the END routine — all other target fields are written. ' +
              'Case-insensitive. Mutually exclusive with fields.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name'],
      },
    },
    {
      name: 'bw_set_transformation_runtime',
      description:
        'Switch a Transformation between HANA and ABAP runtime. ' +
        'Only changes the HANARuntime attribute — no rule changes. ' +
        'The current runtime is read from the active version; if it already matches, returns early. ' +
        'Activates automatically and verifies the change landed in the active version — no separate bw_activate needed. ' +
        'Returns an error (not success) if the switch does not persist, e.g. when the server refuses HANA runtime for this transformation.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key).',
          },
          runtime: {
            type: 'string',
            enum: ['hana', 'abap'],
            description: '"hana" sets HANARuntime="true", "abap" sets HANARuntime="false".',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['transformation_name', 'runtime'],
      },
    },
    {
      name: 'bw_activate',
      description:
        'Activate one BW object (aDSO, Transformation, DTP, InfoObject, InfoSource, DataSource, CompositeProvider, or Aggregation Level). ' +
        'Pass the lock_handle from bw_update_adso or bw_update_transformation. ' +
        'For DTP and DataSource (rsds) activation use lock_handle="" (no lock needed — standalone activation). ' +
        'For object_type "rsds" also pass source_system (a DataSource is identified by DataSource name plus source system). ' +
        'Unlock is sent automatically after activation (not for DTPs or DataSources). ' +
        'The response lists any DTPs deactivated by impact analysis — these must be re-activated.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            enum: ['adso', 'trfn', 'dtpa', 'iobj', 'trcs', 'rsds', 'hcpr', 'alvl'],
            description:
              'Object type: adso, trfn, dtpa, iobj, trcs, rsds (DataSource), hcpr (CompositeProvider), ' +
              'or alvl (Aggregation Level).',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "OBJECT_NAME" or "DTP_..."). For rsds, the DataSource name.',
          },
          lock_handle: {
            type: 'string',
            description:
              'Lock handle from bw_update_adso or bw_update_transformation. ' +
              'Use empty string "" for DTP and DataSource (rsds) activation, and for an ' +
              'Aggregation Level (alvl) created with bw_create_aggregation_level.',
          },
          source_system: {
            type: 'string',
            description: 'Source system name. Required when object_type is "rsds" (e.g. "LSYS_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
        },
        required: ['object_type', 'object_name', 'lock_handle'],
      },
    },
    {
      name: 'bw_delete',
      description:
        'Delete a BW object permanently (aDSO, InfoObject, Transformation, DTP, Query, etc.). ' +
        'Sequence: lock (with /m) → DELETE → unlock. No activation needed — deletion is immediate. ' +
        'Queries (object_type "query", alias "elem") use a dedicated delete sequence; deleting a query ' +
        'does NOT delete the reusable components (variables, CKFs, RKFs) it references — only the query itself. ' +
        'Dependency note: delete aDSOs before their InfoObjects, not the other way around.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'BW object type: adso, iobj, trfn, dtpa, query (alias elem), etc.',
          },
          object_name: {
            type: 'string',
            description: 'Technical object name (e.g. "OBJECT_NAME").',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_unlock',
      description:
        'Release a lock on a BW object without activating it. ' +
        'Use this to discard changes and free the lock, e.g. after an aborted create or update. ' +
        'For DTPs (dtpa) this releases the DTP framework enqueue lock (SM12: RSBKDTP) that can ' +
        'otherwise linger and block the next run or edit of the same DTP.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            enum: ['adso', 'trfn', 'trcs', 'iobj', 'area', 'dtpa', 'hcpr', 'alvl'],
            description:
              'Object type: adso, trfn, trcs, iobj, area (InfoArea), dtpa (DTP), ' +
              'hcpr (CompositeProvider) or alvl (Aggregation Level).',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "OBJECT_NAME").',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_infosource',
      description: 'Read an InfoSource (TRCS) structure — fields, key fields, label, InfoArea, version status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_infoarea',
      description: 'Read an InfoArea definition — name, label, parent area, object status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoArea name (e.g. "NEXTJUICE").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_infosource',
      description:
        'Create a new InfoSource (TRCS) shell. ' +
        'Optionally copy fields from an existing aDSO, CompositeProvider, DataSource, or InfoObject via copy_from_* parameters. ' +
        'Created inactive — call bw_activate with object_type "trcs" afterwards. ' +
        'To add fields after creation use bw_update_infosource.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
          description: {
            type: 'string',
            description: 'Description / label for the InfoSource.',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea to create the InfoSource in (e.g. "MCPBW").',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          copy_from_object_name: {
            type: 'string',
            description: 'Technical name of the source object to copy fields from. Required when copy_from_object_type is set.',
          },
          copy_from_object_type: {
            type: 'string',
            enum: ['ADSO', 'HCPR', 'RSDS', 'IOBJ'],
            description: 'Type of the source object: ADSO (aDSO), HCPR (CompositeProvider), RSDS (DataSource), IOBJ (InfoObject).',
          },
          copy_from_object_sub_type: {
            type: 'string',
            enum: ['ATTR', 'TEXT', 'HIER'],
            description: 'SubType for IOBJ only: ATTR (Attribute), TEXT (Text), HIER (Hierarchy).',
          },
          copy_from_source_system: {
            type: 'string',
            description: 'Source system name (required when copy_from_object_type is RSDS, e.g. "PC_FILE").',
          },
        },
        required: ['name', 'description', 'info_area'],
      },
    },
    {
      name: 'bw_update_infosource',
      description:
        'Update an InfoSource — change description, add/remove fields, and update labels. ' +
        'Provide fields as an array of the fields to add, and remove_fields as an array of field names to delete; ' +
        'other existing fields are always preserved verbatim. ' +
        'Each field can reference an InfoObject (set infoobject_name) or be a local field (omit infoobject_name). ' +
        'Returns a lock_handle for bw_activate.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
          description: {
            type: 'string',
            description: 'New description text (optional — omit to leave unchanged).',
          },
          fields: {
            type: 'array',
            description: 'Fields to add (or whose label to update). Existing fields are preserved; omit to leave fields unchanged.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (uppercase).' },
                infoobject_name: { type: 'string', description: 'InfoObject name to bind this field to (omit for local fields).' },
                type: { type: 'string', description: 'Data type (e.g. CHAR, NUMC, DEC, CURR, DATS).' },
                length: { type: 'number', description: 'Field length.' },
                label: { type: 'string', description: 'Field label / description.' },
                is_key: { type: 'boolean', description: 'If true, also adds a keyElement entry.' },
                aggregation_behavior: {
                  type: 'string',
                  enum: ['NONE', 'SUM', 'MIN', 'MAX', 'AVG', 'LAST'],
                  description: 'Aggregation behavior (default "NONE").',
                },
              },
              required: ['name', 'type', 'length', 'label'],
            },
          },
          remove_fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Field names to remove from the InfoSource (e.g. FIELD_NAME). Other existing fields are preserved.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only required if the BW system requires transport assignment.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_dtps',
      description:
        'List DTPs (Data Transfer Processes) that depend on a BW object. ' +
        'Uses the xref endpoint filtered to DTPA object type. ' +
        'Use object_type=TRFN and the transformation name to find DTPs after activating a transformation.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type of the referenced object: ADSO, TRFN, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name to find dependent DTPs for.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_dtp',
      description:
        'Read a DTP (Data Transfer Process) definition — source, target, transformation, extraction settings, and filter fields (selections and routines). ' +
        'Use bw_xref on an aDSO to find the DTP name first. ' +
        'To find only the process chain a DTP belongs to, use bw_xref with object_type=DTPA instead — it is faster and avoids loading the full DTP definition.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name (e.g. "DTP_...").',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_get_process_chain',
      description:
        'Read a Process Chain (RSPC) definition — header metadata, scheduling and monitoring ' +
        'settings, all steps (nodes) with type, variant, and last execution status, ' +
        'step dependencies (edges) with branch conditions for DECISION nodes, ' +
        'and inline variant details. ' +
        'By default (include_variant_details=true), automatically fetches and embeds the full ' +
        'variant configuration for each step that has detail available. ' +
        'Steps without variant detail (DTP_LOAD, OR, AND, EXOR, CHAIN) are shown without extra detail — ' +
        'for DTP_LOAD use bw_get_dtp, for CHAIN use bw_get_process_chain recursively. ' +
        'Set include_variant_details=false for a faster structural overview without variant detail. ' +
        'Use bw_search with object_type=RSPC to find chain names first.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": full parsed JSON.',
          },
          include_variant_details: {
            type: 'boolean',
            description: 'If true (default), fetches variant configuration detail for each step automatically and includes it inline. Set to false to skip variant detail fetching for faster response on large chains.',
          },
        },
        required: ['chain_name'],
      },
    },
    {
      name: 'bw_get_process_variant',
      description:
        'Read the detail configuration of a single Process Variant from a Process Chain step. ' +
        'Covers all process types: ABAP (report name + selection variant), ADSOACT (aDSO activation), ' +
        'ADSOREM (request cleanup), PLSWITCHL/PLSWITCHP (planning mode switch), DTP_LOAD, ' +
        'DECISION, and any other type — oDetail is returned as indented JSON for unknown types. ' +
        'Get process_type and variant_name from bw_get_process_chain output (sProcessType and sProcessVariant fields). ' +
        'Use format="raw" to see the full unformatted JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          process_type: {
            type: 'string',
            description: 'Process type technical name from the chain step (e.g. "ABAP", "DTP_LOAD", "ADSOACT", "ADSOREM", "PLSWITCHL", "PLSWITCHP", "DECISION"). Case-insensitive.',
          },
          variant_name: {
            type: 'string',
            description: 'Process variant technical name from the chain step (e.g. "ILV_...", "DTP_...", "DEL_..."). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary with oDetail as indented JSON. "raw": full parsed JSON.',
          },
        },
        required: ['process_type', 'variant_name'],
      },
    },
    {
      name: 'bw_list_requests',
      description:
        'List the recent load requests of an InfoProvider from the runtime request monitor, ' +
        'with decoded request status, record counts and timestamps. ' +
        'Returns one entry per request including the internal request TSN, which is the ' +
        'input for bw_get_request. Read-only. ' +
        'Use bw_search to find the target technical name first. ' +
        'Performance: listing cost scales with the number of returned rows because each row ' +
        'is enriched on the backend (a per-row cross-reference read). top bounds the result set; ' +
        'created_from and status only help by returning fewer rows, not by making a row cheaper. ' +
        'For providers with long load histories, use a narrow created_from window or a small top.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target InfoProvider technical name (e.g. "OBJECT_NAME"). Case-insensitive.',
          },
          target_type: {
            type: 'string',
            description: 'Target object type (default "ADSO").',
          },
          storage: {
            type: 'string',
            description: 'Comma-separated storage area codes (default "AQ,AX,AT").',
          },
          status: {
            type: 'string',
            description: 'Comma-separated request status codes to include (default "N,GG,GR,YG,RR,YR,RG,U,Y,X").',
          },
          created_from: {
            type: 'string',
            description:
              'Optional server-side lower time bound, ISO 8601 with milliseconds and Z ' +
              '(24 chars, e.g. "YYYY-MM-DDTHH:MM:SS.000Z"). Returns only requests created at or ' +
              'after this time (open upper bound = now). Narrows the result set, which reduces ' +
              'per-row backend enrichment cost. Recommended for providers with long load histories.',
          },
          top: {
            type: 'number',
            description:
              'Upper cap on the number of requests to return (default 3). Each returned row triggers ' +
              'an expensive per-row backend read, so keep this small; raise it only when needed.',
          },
        },
        required: ['target'],
      },
    },
    {
      name: 'bw_get_request',
      description:
        'Full status analysis of one load request in a single call, bundling the request ' +
        'header, DTP information (including start, finish and duration), the process step ' +
        'chain and the message log. Read-only. ' +
        'The request TSN comes from bw_list_requests output.',
      inputSchema: {
        type: 'object',
        properties: {
          request_tsn: {
            type: 'string',
            description: 'Internal request TSN from bw_list_requests output.',
          },
          storage: {
            type: 'string',
            description:
              'Storage area code (default "AQ"). Take it from the "Storage" line of the ' +
              'bw_list_requests output — the code differs by target type (e.g. AQ inbound, ' +
              'AT/AX active data aDSO, ATTE active text table InfoObject). A wrong code 404s ' +
              'the header/DTP/process sections, but the message log is still returned.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary. "raw": full parsed JSON of all four payloads.',
          },
        },
        required: ['request_tsn'],
      },
    },
    {
      name: 'bw_activate_request',
      description:
        'Activate loaded data (DSO request activation): move a finished load from the Inbound ' +
        'Table into the active data table and change log. This is the runtime request activation, ' +
        'NOT the modeling-object activation done by bw_activate. ' +
        'Only applies to aDSOs that have an activation step (not inbound-only staging aDSOs). ' +
        'Activates all previous loads up to the given request. ' +
        'Asynchronous: a successful call starts activation; monitor completion via ' +
        'bw_list_requests / bw_get_request.',
      inputSchema: {
        type: 'object',
        properties: {
          request_tsn: {
            type: 'string',
            description: 'Load request TSN to activate (from bw_list_requests / bw_run_dtp output).',
          },
          storage: {
            type: 'string',
            description: 'Storage area code the request lives in (default "AQ").',
          },
        },
        required: ['request_tsn'],
      },
    },
    {
      name: 'bw_list_remodeling_requests',
      description:
        'List remodeling requests from the remodeling monitor, with decoded status, last run ' +
        'and creator. Remodeling changes the structure of an existing InfoProvider (e.g. adding, ' +
        'deleting or reassigning a field of an aDSO) and converts the data it already holds. ' +
        'Read-only. ' +
        'Rules are not created by this tool family — BW creates one automatically when an ' +
        'aDSO holding data is activated after a change that cannot be applied to the existing ' +
        'data in place (changing the key definition, deleting a field, changing a data type). ' +
        'Merely appending a field does not trigger one: the column is added and old records ' +
        'keep the initial value. The activation reports "remodeling rule <ID> created instead ' +
        'of the activation"; that ID is the remodeling_rule of the resulting request.',
      inputSchema: {
        type: 'object',
        properties: {
          info_provider: {
            type: 'string',
            description:
              'Optional InfoProvider technical name (e.g. "OBJECT_NAME") to filter on. ' +
              'Case-insensitive. Omit to list requests of all InfoProviders.',
          },
          status: {
            type: 'string',
            description:
              'Optional comma-separated status codes to include: N not scheduled, S scheduled, ' +
              'R running, C completed, E error. Omit to list every request regardless of status.',
          },
          top: {
            type: 'number',
            description:
              'Upper cap on the number of requests to return (default 20). When the cap cuts ' +
              'the list short, the output says so and reports the total — do not read a ' +
              'truncated list as the complete set of open requests.',
          },
        },
      },
    },
    {
      name: 'bw_get_remodeling_request',
      description:
        'Full status of one remodeling request: header, the five processing steps ' +
        '(CHECK, SAVE, CONVERT, ACTIVATE, CLEANUP) with their individual status, and the ' +
        'application log messages. Read-only. ' +
        'This is the tool to diagnose a failed remodeling — the log carries the reason. ' +
        'A "running" status is never reported on the monitor service alone: it is buffered and ' +
        'keeps reporting Running after a run has finished, so the status is cross-checked ' +
        'against the runtime tables and the batch job. A corrected status names its source; ' +
        'if the run is demonstrably over but the header still lags, the output warns about it. ' +
        'Poll this tool to wait for a run to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          info_provider: {
            type: 'string',
            description: 'InfoProvider technical name the rule belongs to. Case-insensitive.',
          },
          remodeling_rule: {
            type: 'string',
            description: 'Remodeling rule ID, from bw_list_remodeling_requests output.',
          },
          request_number: {
            type: 'string',
            description:
              'Optional request GUID from bw_list_remodeling_requests output. When omitted, the ' +
              'most recent request of the given InfoProvider and rule is resolved automatically.',
          },
          include_log: {
            type: 'boolean',
            description: 'Include the application log messages (default true).',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary. "raw": full parsed JSON.',
          },
        },
        required: ['info_provider', 'remodeling_rule'],
      },
    },
    {
      name: 'bw_run_remodeling',
      description:
        'Start, restart or reset a remodeling request. WRITE OPERATION WITH DATA IMPACT: ' +
        'executing a remodeling rule restructures the InfoProvider and converts its existing ' +
        'data — it is not a plain reload and cannot simply be undone. ' +
        'Asynchronous: the call schedules the run; monitor completion with ' +
        'bw_get_remodeling_request. ' +
        'Actions: "execute" starts a request that has not run, "restart" resumes a failed one, ' +
        '"reset" resets the whole request, "reset_step" resets only the current step.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['execute', 'restart', 'reset', 'reset_step'],
            description: 'Action to perform (default "execute").',
          },
          info_provider: {
            type: 'string',
            description: 'InfoProvider technical name the rule belongs to. Case-insensitive.',
          },
          remodeling_rule: {
            type: 'string',
            description: 'Remodeling rule ID, from bw_list_remodeling_requests output.',
          },
          request_number: {
            type: 'string',
            description:
              'Optional request GUID from bw_list_remodeling_requests output. When omitted, the ' +
              'most recent request of the given InfoProvider and rule is resolved automatically.',
          },
          start: {
            type: 'string',
            description:
              'Start time for "execute" and "restart": "immediate" (default) or an ISO 8601 ' +
              'timestamp to schedule the background job for a later point in time. ' +
              'Ignored by the reset actions.',
          },
        },
        required: ['info_provider', 'remodeling_rule'],
      },
    },
    {
      name: 'bw_create_dtp',
      description:
        'Create a new DTP (Data Transfer Process) for an existing Transformation and activate it. ' +
        'The DTP name is server-generated. ' +
        'Optionally set a filter on one source field (Equal operator). ' +
        'After creation the DTP is activated automatically. ' +
        'IMPORTANT: Before calling this tool, always check the full transformation chain. ' +
        'Single-step chain (e.g. ADSO->ADSO): use trfn_name only. ' +
        'Two-step chain (e.g. ADSO->TRCS->ADSO): use trfn_name for the first transformation and trfn_name_2 for the second; ' +
        'source_name/source_type = the start object, target_name/target_type = the end object. ' +
        'Omitting trfn_name_2 in a two-step chain causes a persistent HTTP 500 error. ' +
        'Use bw_get_transformation or bw_xref to determine the chain before creating the DTP. ' +
        'DataSource source: set source_type "RSDS" and pass source_system (the DataSource source system). ' +
        'source_name is then the plain DataSource name; the tool builds the RSDS compound source key internally.',
      inputSchema: {
        type: 'object',
        properties: {
          trfn_name: {
            type: 'string',
            description: 'Technical name of the existing Transformation (UUID-like key).',
          },
          trfn_name_2: {
            type: 'string',
            description: 'Optional second transformation in a multi-step chain. Include when the DTP spans two transformations (e.g. ADSO→TRCS→ADSO).',
          },
          source_name: {
            type: 'string',
            description: 'Source object name (e.g. "SOURCE_NAME").',
          },
          source_type: {
            type: 'string',
            description: 'Source object type (e.g. "ADSO", "TRCS", "RSDS"). Use "RSDS" for a DataSource source — source_system is then required.',
          },
          source_system: {
            type: 'string',
            description: 'Source system name of the DataSource. Required when source_type is "RSDS".',
          },
          target_name: {
            type: 'string',
            description: 'Target object name (e.g. "TARGET_NAME").',
          },
          target_type: {
            type: 'string',
            description: 'Target object type (e.g. "ADSO"). Use "IOBJ" to load into an InfoObject; ' +
              'the loaded sub-object (attributes / texts / hierarchies) is selected with ' +
              'target_object_subtype.',
          },
          target_object_subtype: {
            type: 'string',
            enum: ['ATTR', 'TEXT', 'HIER'],
            description: 'InfoObject sub-object to load into. Only applies when target_type is "IOBJ". ' +
              'ATTR (default) = attributes/master data (IOBJA), TEXT = texts (IOBJT), ' +
              'HIER = hierarchies (IOBJH). Must match the sub-object the transformation chain targets.',
          },
          description: {
            type: 'string',
            description: 'Optional DTP description text (default: empty).',
          },
          package: {
            type: 'string',
            description: 'Development package (default "$TMP").',
          },
          ...DTP_FILTER_SCHEMA_PROPS,
        },
        required: ['trfn_name', 'source_name', 'source_type', 'target_name', 'target_type'],
      },
    },
    {
      name: 'bw_run_dtp',
      description:
        'Start (execute) a run of an existing, active DTP. ' +
        'Triggers the load with a single request and returns the new run request id. ' +
        'The returned request_id is the RSPM request TSN: pass it straight into ' +
        'bw_get_request (as request_tsn) to monitor load status — no bw_list_requests lookup needed.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'Technical name of the DTP to run (e.g. "DTP_...").',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_set_dtp_filter_routine',
      description:
        'Set an ABAP filter routine on a DTP filter field. Use this only when custom ABAP code is needed for the filter logic; for value sets, ranges and patterns use the filter parameters of bw_update_dtp. ' +
        'Repeatable on the same field: the routine replaces the previous one, existing value selections on the field are kept, and a failed attempt leaves neither a routine nor a generated report behind.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name (e.g. "DTP_...").',
          },
          field_name: {
            type: 'string',
            description: 'Filter field name as it appears in the DTP XML fields element.',
          },
          routine_code: {
            type: 'string',
            description: 'ABAP routine code (plain text, without FORM/ENDFORM wrapper).',
          },
          global_code: {
            type: 'string',
            description: 'Optional global declarations for the routine.',
          },
        },
        required: ['dtp_name', 'field_name', 'routine_code'],
      },
    },
    {
      name: 'bw_update_dtp',
      description:
        'Update DTP properties: description, the value selection of one filter field, extraction mode (Full vs Delta), and/or the semantic group. Use this for setting filter values on existing filter fields. ' +
        'A filter is written per field as a complete selection — a second call on the same field replaces the first, it does not add to it, so pass the whole value set at once. ' +
        'Note: switching extraction mode between Delta and Full (and back) has BW delta-init implications — a later delta load may require re-initialization of the delta on the source.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name to update (e.g. "DTP_...").',
          },
          description: {
            type: 'string',
            description: 'New description text for the DTP.',
          },
          ...DTP_FILTER_SCHEMA_PROPS,
          filter_clear_fields: {
            type: 'string',
            description:
              'Comma-separated list of field names whose value selections are removed. The field ' +
              'is deselected as well unless it carries a filter routine, which then stays the ' +
              'active filter.',
          },
          extraction_mode: {
            type: 'string',
            enum: ['full', 'delta'],
            description: 'Switch the DTP extraction mode. "full" sets extractionMode="F"; "delta" sets extractionMode="D" (only valid for delta-capable sources). Switching modes has delta-init implications — see the tool note.',
          },
          semantic_group_fields: {
            type: 'string',
            description:
              'Comma-separated list of field names that form the semantic group (e.g. "FIELD_NAME,/BIC/FIELD_NAME"). ' +
              'Replaces the current selection completely: the listed fields become the semantic group, all others are deselected. ' +
              'Pass an empty string to clear the semantic group. Use bw_get_dtp to read the available group field names — ' +
              'they must match exactly, including any /BIC/ prefix.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
          transport_lock_holder: {
            type: 'string',
            description: 'Transport lock holder. The transport request that currently owns the object lock. Required on some systems when updating an existing object.',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_get_push_schema',
      description:
        'Fetch the JSON schema for an aDSO write interface. ' +
        'Returns field names, data types, and required fields. ' +
        'Use this before bw_push_data to know what fields to include in records.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO technical name (e.g. "ADSO_NAME").',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_push_data',
      description:
        'Push data records directly into an aDSO inbound table via the SAP BW/4HANA write interface. ' +
        'The aDSO must have write_interface enabled (pushMode="true"). ' +
        'Use bw_get_push_schema first to verify field names and types. ' +
        'Success = HTTP 204 (SAP returns empty body). ' +
        'DATS fields must be formatted as YYYYMMDD strings. INT4 fields as JSON integers.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO technical name (e.g. "ADSO_NAME").',
          },
          records: {
            type: 'array',
            description: 'Array of record objects. Field names must match aDSO field names exactly (uppercase).',
            items: { type: 'object' },
          },
          mode: {
            type: 'string',
            enum: ['one_step', 'messaging'],
            description: 'Push mode. "one_step" (default): implicit request per call. "messaging": uses ?request=MESSAGING param.',
          },
        },
        required: ['adso_name', 'records'],
      },
    },
    {
      name: 'bw_get_query',
      description:
        'Read a BW Query definition — variables, filter, layout (rows/columns/free characteristics), ' +
        'calculated and restricted measures, exceptions, and cell definitions. ' +
        'Tries the active version first; falls back to the inactive version if not found. ' +
        'format="text" (default): compact human-readable output. format="raw": full parsed JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query (e.g. "QUERY_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default): structured human-readable output. "raw": full parsed JSON.',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_create_query',
      description:
        'Create a new BW Query (TLOGO ELEM) on an InfoProvider in package $TMP. ' +
        'Without copy_from the query is created empty and consistent (no rows, columns, or key figures yet). ' +
        'With copy_from the new query is created as a full copy of an existing query (layout, filter, ' +
        'variables, key figures); the description parameter still applies to the copy, and infoprovider ' +
        'may be omitted (it is derived from the source query). ' +
        'Support for transportable packages is not yet available; only package $TMP is supported.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to create (e.g. "QUERY_NAME").',
          },
          infoprovider: {
            type: 'string',
            description:
              'Technical name of the InfoProvider the query is built on (e.g. "PROVIDER_NAME"). ' +
              'Required unless copy_from is given, in which case it defaults to the source query\'s provider.',
          },
          description: {
            type: 'string',
            description: 'Query description. Defaults to query_name if omitted.',
          },
          copy_from: {
            type: 'string',
            description:
              'Technical name of an existing query to copy (e.g. "QUERY_NAME"). The new query is created ' +
              'as a full copy of its content.',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_create_variable',
      description:
        'Create a reusable BW Variable on a characteristic, for use as a filter parameter in ' +
        'queries. The variable is created active and consistent. Covers processing types ' +
        'UserEntry (manual entry, the default), CustomerExit, Authorization and the ' +
        'current-member flavour of ReplacementPath, and stands for a characteristic value, ' +
        'a hierarchy or hierarchy nodes. Text and formula variables are not supported. ' +
        'To keep a variable out of the user\'s variable screen, set ready_for_input false.',
      inputSchema: {
        type: 'object',
        properties: {
          variable_name: {
            type: 'string',
            description: 'Technical name of the variable to create (e.g. "VAR_NAME").',
          },
          iobj_name: {
            type: 'string',
            description: 'Technical name of the InfoObject (characteristic) this variable is based on (e.g. "0CALMONTH"). Must exist in the system.',
          },
          description: {
            type: 'string',
            description: 'Variable description (displayed in query parameter screens).',
          },
          development_class: {
            type: 'string',
            description: 'Package name (e.g. "ZPKG"). Defaults to $TMP if omitted.',
          },
          ready_for_input: {
            type: 'boolean',
            description: 'Whether the variable is shown on the variable screen for user input. Defaults to true. Set false for a variable that only the customer exit fills.',
          },
          reusable: {
            type: 'boolean',
            description: 'Whether the variable can be reused in multiple queries. Defaults to true.',
          },
          represents: {
            type: 'string',
            enum: ['Interval', 'SingleValue', 'SeveralSingleValues', 'SelectionOption'],
            description: 'Selection type. Interval is a from/to range, SelectionOption allows the full set of comparison operators. Defaults to Interval.',
          },
          processing_type: {
            type: 'string',
            enum: ['UserEntry', 'CustomerExit', 'Authorization', 'ReplacementPath'],
            description: 'How the variable is filled: UserEntry (manual entry by the user, the default), CustomerExit (filled by the exit), Authorization, or ReplacementPath. Replacement path is limited to the current-member variant, which needs no donor object; replacement from a query result is not supported.',
          },
          variable_type: {
            type: 'string',
            enum: ['CharacteristicValue', 'Hierarchy', 'HierarchyNodes'],
            description: 'What the variable stands for: a characteristic value (default), a whole hierarchy, or hierarchy nodes. Hierarchy variables still reference a characteristic via iobj_name.',
          },
          input_type: {
            type: 'string',
            enum: ['Optional', 'MandatoryWithInitial', 'MandatoryWithoutInitial'],
            description: 'Whether a value is required: Optional (default), MandatoryWithInitial (entry required, initial value allowed) or MandatoryWithoutInitial (entry required, initial value rejected).',
          },
          master_language: {
            type: 'string',
            description: 'Language code for the descriptions (e.g. "EN", "DE"). Defaults to the BW_LANGUAGE of the connection, otherwise "EN".',
          },
          package: {
            type: 'string',
            description: 'Alias for development_class (for consistency with other tools).',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. "DEVK900123"). Only needed when the target package is transportable.',
          },
        },
        required: ['variable_name', 'iobj_name', 'description'],
      },
    },
    {
      name: 'bw_update_query_layout',
      description:
        'Modify an existing BW Query layout: add or remove characteristics in the rows, columns, or ' +
        'free-characteristics area, and add or remove references to reusable structures (a structure is a ' +
        'layout container). All operations are applied in a single save. ' +
        'All names must be technical names (e.g. "IOBJ_NAME", "STRUCTURE_NAME", "QUERY_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to modify (e.g. "QUERY_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only needed when the query lives on a transportable package; omit for $TMP queries.',
          },
          operations: {
            type: 'array',
            description: 'Layout changes to apply in one save cycle.',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['add', 'remove', 'add_structure', 'remove_structure'],
                  description:
                    'add / remove: add a characteristic to a container or remove it from the layout. ' +
                    'add_structure: add a reference to a reusable structure into rows or columns. ' +
                    'remove_structure: remove a referenced reusable structure.',
                },
                target: {
                  type: 'string',
                  enum: ['rows', 'columns', 'free'],
                  description:
                    'Target container. Required for "add" (rows, columns, or free) and "add_structure" ' +
                    '(rows or columns).',
                },
                infoobject: {
                  type: 'string',
                  description: 'Technical name of the characteristic (required for "add" / "remove", e.g. "IOBJ_NAME").',
                },
                structure_name: {
                  type: 'string',
                  description:
                    'Technical name of the reusable structure (required for "add_structure" / ' +
                    '"remove_structure", e.g. "STRUCTURE_NAME").',
                },
                description: {
                  type: 'string',
                  description: 'Optional display description for "add". Defaults to the InfoObject name.',
                },
              },
              required: ['action'],
            },
          },
        },
        required: ['query_name', 'operations'],
      },
    },
    {
      name: 'bw_update_query_filter',
      description:
        'Modify an existing BW Query filter. Supported restrictions: fixed values — single values, ' +
        'intervals (via "high"), and exclusions (via "exclude") — and reusable variable references ' +
        '(via "set_variable"). All operations are applied in a single save. ' +
        'Key figure members are not yet supported. ' +
        'All names must be technical names (e.g. "IOBJ_NAME", "QUERY_NAME", "VAR_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to modify (e.g. "QUERY_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only needed when the query lives on a transportable package; omit for $TMP queries.',
          },
          operations: {
            type: 'array',
            description: 'Filter changes to apply in one save cycle.',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['set_values', 'set_variable', 'remove'],
                  description:
                    'set_values: set the fixed restriction (single values, intervals, exclusions) for the ' +
                    'characteristic, replacing any existing filter on it. set_variable: restrict the ' +
                    'characteristic with a reusable variable (variable_name). remove: delete the filter entirely.',
                },
                infoobject: {
                  type: 'string',
                  description:
                    'Technical name of the characteristic (e.g. "IOBJ_NAME"). Required for set_values and ' +
                    'remove; for set_variable it is derived from the variable definition and may be omitted.',
                },
                variable_name: {
                  type: 'string',
                  description: 'Technical name of the reusable variable (required for "set_variable", e.g. "VAR_NAME").',
                },
                values: {
                  type: 'array',
                  description: 'Filter values (required for "set_values").',
                  items: {
                    type: 'object',
                    properties: {
                      value: {
                        type: 'string',
                        description: 'External (display) value to filter on (lower bound of an interval).',
                      },
                      internal_value: {
                        type: 'string',
                        description: 'Internal value for "value". Defaults to value if omitted.',
                      },
                      description: {
                        type: 'string',
                        description: 'Optional description for "value".',
                      },
                      high: {
                        type: 'string',
                        description: 'Upper bound (external value) of an interval. When set, the restriction becomes "Between".',
                      },
                      high_internal_value: {
                        type: 'string',
                        description: 'Internal value for "high". Defaults to high if omitted.',
                      },
                      high_description: {
                        type: 'string',
                        description: 'Optional description for "high".',
                      },
                      exclude: {
                        type: 'boolean',
                        description: 'If true, this restriction is an exclusion ("not equal"). Include and exclude entries may be mixed on one characteristic.',
                      },
                    },
                    required: ['value'],
                  },
                },
              },
              required: ['action'],
            },
          },
        },
        required: ['query_name', 'operations'],
      },
    },
    {
      name: 'bw_update_query_key_figures',
      description:
        'Manage the key figure structure of an existing BW Query: add basic key figures, add references ' +
        'to reusable CKFs/RKFs (with optional local restrictions), add local formula members (recursive ' +
        'operator/operand tree), set member display properties (decimals, hidden, sign inversion) and ' +
        'exception aggregation, and remove members. All operations are applied in a single save. ' +
        'Member operations also apply to a reusable key figure structure referenced via ' +
        'bw_update_query_layout add_structure. ' +
        'All names must be technical names (e.g. "IOBJ_NAME", "CKF_NAME", "QUERY_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to modify (e.g. "QUERY_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only needed when the query lives on a transportable package; omit for $TMP queries.',
          },
          structure_target: {
            type: 'string',
            enum: ['rows', 'columns'],
            description:
              'Container for the key figure structure when it is created by the first add operation ' +
              '(default "columns"). Ignored once a structure already exists.',
          },
          operations: {
            type: 'array',
            description: 'Key figure changes to apply in one save cycle.',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['add_key_figure', 'add_ckf', 'add_rkf', 'add_formula', 'remove_member', 'set_member_properties'],
                  description:
                    'add_key_figure: add a basic key figure (infoobject). add_ckf / add_rkf: add a reference ' +
                    'to a reusable calculated / restricted key figure (component_name). add_formula: add a local ' +
                    'formula member (description + formula). remove_member: remove a member matched by member_id, ' +
                    'description, and/or component_name. set_member_properties: change display properties / ' +
                    'exception aggregation of a matched member.',
                },
                infoobject: {
                  type: 'string',
                  description: 'Basic key figure technical name (required for "add_key_figure", e.g. "IOBJ_NAME").',
                },
                component_name: {
                  type: 'string',
                  description:
                    'Reusable CKF/RKF technical name (required for "add_ckf" / "add_rkf"; optional matcher for ' +
                    '"remove_member" / "set_member_properties", e.g. "CKF_NAME").',
                },
                description: {
                  type: 'string',
                  description:
                    'Member description. Defaults to the key figure / component name on add; required for ' +
                    '"add_formula"; matches the member description on "remove_member" / "set_member_properties".',
                },
                member_id: {
                  type: 'string',
                  description:
                    'Member id matcher for "remove_member" / "set_member_properties". Takes precedence over ' +
                    'description and component_name; use it to disambiguate when those match more than one member.',
                },
                formula: {
                  type: 'object',
                  description:
                    'Formula tree for "add_formula" (recursive). Node forms: ' +
                    '{ "type": "operator", "code": "+|-|*|/|MAX|...", "operands": [node, ...] } ' +
                    '(codes +,-,*,/ are infix, any other code is a prefix function); ' +
                    '{ "type": "member", "description": "..." } or { "type": "member", "member_id": "..." } ' +
                    '(references another structure member); ' +
                    '{ "type": "component", "component_name": "CKF_NAME" } (references the structure member that ' +
                    'wraps that CKF/RKF — the component must already be added as a structure member; a query ' +
                    'formula cannot reference a component id directly); ' +
                    '{ "type": "key_figure", "name": "IOBJ_NAME" }; { "type": "constant", "value": "5" }. ' +
                    'Operator codes (BW analytic engine, operand counts enforced): ' +
                    'basic +,- (1-2), *,/ (2); ** power, DIV, MOD (2). ' +
                    'math ABS, CEIL, FLOOR, FRAC, TRUNC, SIGN, SQRT, EXP, LOG, LOG10, MAX0, MIN0 (1); MAX, MIN (2). ' +
                    'percentage %, %A, %_A (2); %CT, %GT, %RT, %XT, %YT (1). ' +
                    'data COUNT, DELTA, NDIV0, NODIM, NOERR, FIX, DATE, TIME, CMR, SUMCT, SUMGT, SUMRT, SUMXT, SUMYT (1). ' +
                    'trig SIN, COS, TAN, SINH, COSH, TANH, ASIN, ACOS, ATAN (1). ' +
                    'boolean NOT (1); AND, OR, XOR and relational <, <=, <>, ==, >, >= (2); IF cond;true;false (3). ' +
                    '(LEAF is not supported — BW needs a dedicated nullary token this tool does not emit.) ' +
                    'The infix/prefix XML encoding does not matter: BW stores formulas as an execution tree and normalizes ' +
                    'the display, so binary operators (%, **, MOD, relational, boolean) are accepted when emitted as prefix ' +
                    '— tested and confirmed. Only +,-,*,/ are emitted as XML infix.',
                },
                exception_aggregation: {
                  type: 'object',
                  description:
                    'Exception aggregation for the member (add_key_figure / add_ckf / add_rkf / add_formula). ' +
                    'Shape: { "type": "AVG", "reference_characteristic": "IOBJ_NAME" }.',
                  properties: {
                    type: { type: 'string', description: 'Aggregation type (e.g. "AVG", "MAX", "LAS").' },
                    reference_characteristic: { type: 'string', description: 'Reference characteristic technical name (e.g. "IOBJ_NAME").' },
                  },
                  required: ['type', 'reference_characteristic'],
                },
                properties: {
                  type: 'object',
                  description:
                    'Member display properties (for "set_member_properties"; also allowed on "add_formula"). ' +
                    'Only the provided fields are changed.',
                  properties: {
                    decimals: { type: 'integer', minimum: 0, maximum: 9, description: 'Number of decimal places (0-9).' },
                    hidden: {
                      description: 'Visibility: "hide", "showAlways", "showNever", or false to restore the default.',
                    },
                    sign_inversion: { type: 'boolean', description: 'Invert the +/- sign.' },
                    exception_aggregation: {
                      description:
                        'Exception aggregation { "type": "AVG", "reference_characteristic": "IOBJ_NAME" }, or false to reset it.',
                    },
                    description: { type: 'string', description: 'New member description text.' },
                  },
                },
                restrictions: {
                  type: 'array',
                  description:
                    'Optional local restrictions on the member. Each entry restricts one characteristic; the ' +
                    'value schema matches bw_update_query_filter set_values.',
                  items: {
                    type: 'object',
                    properties: {
                      infoobject: {
                        type: 'string',
                        description: 'Characteristic technical name to restrict (e.g. "IOBJ_NAME").',
                      },
                      values: {
                        type: 'array',
                        description: 'Restriction values (single values, intervals via "high", exclusions via "exclude").',
                        items: {
                          type: 'object',
                          properties: {
                            value: {
                              type: 'string',
                              description: 'External (display) value (lower bound of an interval).',
                            },
                            internal_value: {
                              type: 'string',
                              description: 'Internal value for "value". Defaults to value if omitted.',
                            },
                            description: {
                              type: 'string',
                              description: 'Optional description for "value".',
                            },
                            high: {
                              type: 'string',
                              description: 'Upper bound (external value) of an interval. When set, the restriction becomes "Between".',
                            },
                            high_internal_value: {
                              type: 'string',
                              description: 'Internal value for "high". Defaults to high if omitted.',
                            },
                            high_description: {
                              type: 'string',
                              description: 'Optional description for "high".',
                            },
                            exclude: {
                              type: 'boolean',
                              description: 'If true, this restriction is an exclusion ("not equal").',
                            },
                          },
                          required: ['value'],
                        },
                      },
                    },
                    required: ['infoobject', 'values'],
                  },
                },
              },
              required: ['action'],
            },
          },
        },
        required: ['query_name', 'operations'],
      },
    },
    {
      name: 'bw_update_query_settings',
      description:
        'Change query-level display and behaviour settings of an existing BW Query (description, zero ' +
        'suppression, result position, sign presentation, zero presentation, universal display hierarchy, ' +
        'document links, and related flags). Only the provided settings are applied in a single save. ' +
        'The InfoProvider, technical name, and package cannot be changed. ' +
        'All names must be technical names (e.g. "QUERY_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to modify (e.g. "QUERY_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only needed when the query lives on a transportable package; omit for $TMP queries.',
          },
          description: { type: 'string', description: 'Query description text.' },
          zero_suppression_rows: { type: 'boolean', description: 'Suppress zero-value rows.' },
          zero_suppression_columns: { type: 'boolean', description: 'Suppress zero-value columns.' },
          result_position_top: { type: 'boolean', description: 'Place the result row on top.' },
          result_position_left: { type: 'boolean', description: 'Place the result column on the left.' },
          sign_presentation: {
            type: 'string',
            description: 'Sign presentation (e.g. "inFrontOf", "after").',
          },
          suppress_repeated_key_values: { type: 'boolean', description: 'Suppress repeated key values.' },
          show_scaling_factor: { type: 'boolean', description: 'Show the scaling factor.' },
          adjust_formatting: { type: 'boolean', description: 'Adjust formatting.' },
          zero_presentation_kind: { type: 'string', description: 'Zero presentation kind (e.g. "withCurrency").' },
          zero_presentation_custom_value: { type: 'string', description: 'Custom value shown for zeros.' },
          hierarchy_display_rows: {
            type: 'object',
            description: 'Universal display hierarchy for rows.',
            properties: {
              active: { type: 'boolean', description: 'Whether the display hierarchy is active.' },
              level: { type: 'integer', minimum: 0, description: 'Display level (written two-digit).' },
            },
          },
          hierarchy_display_columns: {
            type: 'object',
            description: 'Universal display hierarchy for columns.',
            properties: {
              active: { type: 'boolean', description: 'Whether the display hierarchy is active.' },
              level: { type: 'integer', minimum: 0, description: 'Display level (written two-digit).' },
            },
          },
          document_links: {
            type: 'object',
            description: 'Document link visibility.',
            properties: {
              info_provider: { type: 'boolean', description: 'Show InfoProvider document links.' },
              master_data: { type: 'boolean', description: 'Show master data document links.' },
              meta_data: { type: 'boolean', description: 'Show metadata document links.' },
            },
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_update_query_characteristic',
      description:
        'Set the display and access properties of the characteristics in an existing BW Query - the ' +
        'per-characteristic settings of the rows, columns, and free-characteristics areas: display of result ' +
        'rows, display as key/text, access type for result values (read mode), sorting, cumulation, display ' +
        'level, and the hierarchy assignment with its display options. Pass "*" as infoobject to apply one ' +
        'set of properties to every characteristic in the layout. Every property also accepts "default", ' +
        'which drops the explicit value and falls back to the InfoObject/query default. All specs are ' +
        'applied in a single save. Characteristics must already be in the layout - add them with ' +
        'bw_update_query_layout first. All names must be technical names (e.g. "QUERY_NAME", "CHAR_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query to modify (e.g. "QUERY_NAME").',
          },
          transport: {
            type: 'string',
            description: 'Transport request number (e.g. DEVK900123). Only needed when the query lives on a transportable package; omit for $TMP queries.',
          },
          characteristics: {
            type: 'array',
            description: 'One entry per characteristic, or a single entry with infoobject "*" for all of them.',
            items: {
              type: 'object',
              properties: {
                infoobject: {
                  type: 'string',
                  description: 'Technical name of the characteristic (e.g. "CHAR_NAME"), or "*" for every characteristic in the layout.',
                },
                axis: {
                  type: 'string',
                  enum: ['rows', 'columns', 'free'],
                  description: 'Restrict the change to one area. Omit to hit the characteristic wherever it sits.',
                },
                result_rows: {
                  type: 'string',
                  enum: ['always', 'suppressForOne', 'never', 'default'],
                  description: 'Display of result rows: always show, show only when there is more than one value, or never show.',
                },
                display_as: {
                  type: 'string',
                  enum: ['Key', 'Text', 'KeyAndText', 'TextAndKey', 'noDisplay', 'default'],
                  description: 'How characteristic values are rendered.',
                },
                text_type: {
                  type: 'string',
                  enum: ['standard', 'short', 'medium', 'long'],
                  description: 'Which text the value rendering uses. Only together with display_as; defaults to "standard".',
                },
                access_type: {
                  type: 'string',
                  enum: ['masterdata', 'characteristicRelations', 'factdata', 'dimensiondata', 'default'],
                  description: 'Access type for result values (read mode): master data table, characteristic relationships, values posted in the InfoProvider, or posted values.',
                },
                cumulate: {
                  type: 'string',
                  enum: ['on', 'off', 'default'],
                  description: 'Show the characteristic cumulated.',
                },
                display_level: {
                  type: 'string',
                  enum: ['AlsoInSimple', 'Normal', 'DetailedOnly', 'default'],
                  description: 'Level at which the characteristic is shown.',
                },
                sorting: {
                  type: 'object',
                  description: 'Sorting of the characteristic values.',
                  properties: {
                    by: {
                      type: 'string',
                      enum: ['Key', 'Text', 'default'],
                      description: 'Sort by key or by text; "default" restores sorting as selected.',
                    },
                    direction: {
                      type: 'string',
                      enum: ['Ascending', 'Descending'],
                      description: 'Sort direction (default "Ascending").',
                    },
                    sort_by_characteristic: {
                      type: 'string',
                      description: 'Characteristic or display attribute the sort runs on. Defaults to the characteristic itself.',
                    },
                  },
                  required: ['by'],
                },
                hierarchy: {
                  type: 'object',
                  description: 'Hierarchy assignment and hierarchy display options.',
                  properties: {
                    name: {
                      type: 'string',
                      description: 'Technical name of the hierarchy; "" removes the assignment. Also switches the hierarchy on or off unless active is given explicitly.',
                    },
                    active: { type: 'boolean', description: 'Whether the assigned hierarchy is active.' },
                    version: { type: 'string', description: 'Hierarchy version.' },
                    valid_to: { type: 'string', description: 'Key date of the hierarchy (YYYYMMDD).' },
                    expand_to_level: {
                      type: 'integer',
                      minimum: 0,
                      description: 'Expand the hierarchy to this level; 0 restores the default.',
                    },
                    child_node_position: {
                      type: 'string',
                      enum: ['above', 'below', 'default'],
                      description: 'Position of child nodes relative to their parent.',
                    },
                    postable_node_values: {
                      type: 'string',
                      enum: ['show', 'hide', 'default'],
                      description: 'Show the values posted on nodes.',
                    },
                    suppress_single_child_nodes: {
                      type: 'string',
                      enum: ['on', 'off', 'default'],
                      description: 'Suppress nodes that have only one child.',
                    },
                    sorting: {
                      type: 'object',
                      description: 'Sorting within the hierarchy; "default" sorts as in the hierarchy.',
                      properties: {
                        by: { type: 'string', enum: ['Key', 'Text', 'default'] },
                        direction: { type: 'string', enum: ['Ascending', 'Descending'] },
                      },
                      required: ['by'],
                    },
                  },
                },
              },
              required: ['infoobject'],
            },
          },
        },
        required: ['query_name', 'characteristics'],
      },
    },
    {
      name: 'bw_get_composite_provider',
      description:
        'Read a CompositeProvider (HCPR) structure — general info, view node type (Union/Join), ' +
        'source providers (inputs) with mapping counts, fields with dimension classification, ' +
        'join condition, and temporal join details. Returns the inactive version.',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Technical name of the CompositeProvider (e.g. "HCPR_NAME").',
          },
        },
        required: ['composite_provider_name'],
      },
    },
    {
      name: 'bw_update_composite_provider',
      description:
        'Change a CompositeProvider (HCPR): its fields, its source providers, their field mappings, the join condition, or root settings. ' +
        'Every action returns a lock_handle that must be passed to bw_activate (object type hcpr) — an HCPR cannot be activated without it. ' +
        'Fields: "add_field" (default) adds an element plus a mapping in every part provider supplying it, taking the field metadata from there; "remove_field" removes the element and all mappings referencing it. ' +
        'Sources: "add_input" attaches a source provider, creates the target elements it needs and returns the generated alias; "remove_input" strips one by alias, leaving its elements and any join reference behind. ' +
        'Mappings: "update_mapping" replaces the complete mapping list of one input; pass no mappings to map every field of its source one to one. This is also how an input attached at creation time gets its mappings. ' +
        'Joins: "update_join" sets the condition between one pair of inputs — call it once per pair to build an N-way join — and "remove_join" drops one pair. Note that both sides of a join key must be mapped onto the SAME target field, otherwise activation fails with "join fields need at least one common target field"; auto-mapping does not do this, so map the second side\'s key fields explicitly. ' +
        'Settings: "update_settings" edits label, stackable, default node and aggregation behaviour.',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Technical name of the CompositeProvider (e.g. "HCPR_NAME").',
          },
          action: {
            type: 'string',
            enum: [
              'add_field', 'remove_field', 'add_input', 'remove_input',
              'update_mapping', 'update_join', 'remove_join', 'update_settings',
            ],
            description: 'Defaults to "add_field".',
          },
          info_object_name: {
            type: 'string',
            description: 'add_field / remove_field: field name or comma-separated list (e.g. "IOBJ_NAME" or "IOBJ_A,IOBJ_B").',
          },
          source_providers: {
            type: 'string',
            description:
              'add_field only. Comma-separated part provider names or aliases (e.g. "PROVIDER_NAME" or "U1.ADSO.1") to restrict which inputs get a mapping. ' +
              'Omit to map the field in every part provider that contains it.',
          },
          provider_name: {
            type: 'string',
            description: 'add_input: technical name of the source InfoProvider to attach.',
          },
          provider_type: {
            type: 'string',
            description: 'add_input: TLOGO-style suffix used in the generated alias (e.g. "ADSO"). Defaults to "ADSO".',
          },
          input_alias: {
            type: 'string',
            description: 'remove_input / update_mapping: alias of the input (e.g. "U1.ADSO.1").',
          },
          mappings: {
            type: 'array',
            description:
              'add_input / update_mapping. Omit or pass an empty list to map every field of the source one to one.',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string', description: 'Element name in the CompositeProvider.' },
                source: { type: 'string', description: 'Field name on the source; defaults to target.' },
                constant_value: { type: 'string', description: 'Constant instead of a source field.' },
                info_object_name: { type: 'string', description: 'Bind a newly created target element to this InfoObject.' },
              },
              required: ['target'],
            },
          },
          left_alias: {
            type: 'string',
            description: 'update_join / remove_join: alias of the left input.',
          },
          right_alias: {
            type: 'string',
            description: 'update_join / remove_join: alias of the right input.',
          },
          key_pairs: {
            type: 'array',
            description: 'update_join: the join key field pairs, named as they appear on each side\'s own source.',
            items: {
              type: 'object',
              properties: {
                left: { type: 'string' },
                right: { type: 'string' },
              },
              required: ['left', 'right'],
            },
          },
          join_type: {
            type: 'string',
            description: 'update_join: "inner" (default), "leftOuter", etc. — lowercase first letter.',
          },
          cardinality: {
            type: 'string',
            description: 'update_join: defaults to "CN_N".',
          },
          label: {
            type: 'string',
            description: 'update_settings: new description.',
          },
          stackable: {
            type: 'boolean',
            description: 'update_settings.',
          },
          default_node: {
            type: 'string',
            description: 'update_settings: path reference to the default view node (e.g. "#///U1").',
          },
          aggregation_behaviour: {
            type: 'string',
            description: 'update_settings.',
          },
          transport: {
            type: 'string',
            description: 'Optional transport request (e.g. DEVK900123). Omit for local objects.',
          },
        },
        required: ['composite_provider_name'],
      },
    },
    {
      name: 'bw_create_composite_provider',
      description:
        'Create a CompositeProvider (HCPR). Without copy_from it creates a view node of the given type with the listed source providers attached — entity only, so give them their mappings afterwards with bw_update_composite_provider action "update_mapping". ' +
        'A Union node may be created empty; a JOIN node must be created WITH its sources, since a join node without inputs makes the server dump. ' +
        'With copy_from the server copies view node, inputs and mappings from an existing CompositeProvider. ' +
        'The result is inactive — activate it with bw_activate (object type hcpr).',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Name for the new CompositeProvider (e.g. "HCPR_NAME").',
          },
          label: { type: 'string', description: 'Description.' },
          info_area: { type: 'string', description: 'InfoArea to create it in (e.g. "AREA_NAME").' },
          view_type: {
            type: 'string',
            enum: ['Join', 'Union'],
            description: 'View node type. Defaults to "Join".',
          },
          inputs: {
            type: 'array',
            description: 'Source InfoProviders to attach right away. Required in practice for a Join node.',
            items: {
              type: 'object',
              properties: {
                provider_name: { type: 'string' },
                provider_type: { type: 'string', description: 'TLOGO-style suffix, e.g. "ADSO". Defaults to "ADSO".' },
              },
              required: ['provider_name'],
            },
          },
          copy_from: {
            type: 'string',
            description:
              'Copy the structure of this existing CompositeProvider. view_type, inputs and stackable are then irrelevant — they come from the template.',
          },
          stackable: { type: 'boolean', description: 'Defaults to false.' },
          package: { type: 'string', description: 'Development package (default "$TMP").' },
        },
        required: ['composite_provider_name', 'label', 'info_area'],
      },
    },
    {
      name: 'bw_list_contents',
      description:
        'Read the direct children of any node in the BW repository tree. ' +
        'The path parameter maps to the navigation hierarchy: ' +
        'use "/" or "" for all InfoAreas, ' +
        '"area/{name}" for InfoArea contents (object type folders), ' +
        '"area/{name}/{folder}" for objects within a folder (e.g. "area/MYAREA/adso"), ' +
        '"{type}/{name}" to expand an object (e.g. "hcpr/CP_NAME" → sub-folders), ' +
        '"{type}/{name}/{subfolder}" for objects within a sub-folder (e.g. "adso/ADSO_NAME/trfn"). ' +
        'Returns name, description, object_type, object_subtype, status, has_children, ' +
        'self_url, fiori_only, and children_path (pass directly to bw_list_contents to drill down).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Repository path to list. Use "/" or "" for all InfoAreas. ' +
              'Examples: "area/MYAREA", "area/MYAREA/hcpr", "hcpr/CP_NAME", "hcpr/CP_NAME/elem_ckf", "adso/ADSO_NAME/trfn".',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'bw_read_metadata_tables',
      description:
        'Read a BW object definition directly from its metadata tables (via the ADT DataPreview service). ' +
        'Read-only fallback for object types the connected system does not publish as a REST resource — ' +
        'on classic SAP BW (7.5) that is typically transformations and DTPs, and the classic providers, ' +
        'for which no release ships a REST resource. ' +
        'Use bw_system_profile to see which endpoints a system publishes. ' +
        'Supported object_type: TRFN (transformation incl. start/end/expert and field routine source code), ' +
        'DTPA (data transfer process), ODSO (classic DataStore Object), CUBE (InfoCube), MPRO (MultiProvider) ' +
        'and RSPC (process chain: steps with their variant parameters, in execution order — every step follows its ' +
        'predecessors, but branches that run in parallel have no order among themselves, so read the "After" line ' +
        'of each step for the actual dependency). ' +
        'Requires ADT authorization for the calling user. Prefer bw_get_transformation where the REST endpoint exists.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type to read. Supported: TRFN, DTPA, ODSO, CUBE, MPRO, RSPC.',
          },
          object_name: {
            type: 'string',
            description: 'Technical name of the object (for TRFN the UUID-like transformation ID).',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_system_profile',
      description:
        'Find out what the connected BW system is and which of this server\'s tools will work on it. ' +
        'Distinguishes SAP BW/4HANA from classic SAP BW (7.5) via the system\'s own b4hanamode flag, ' +
        'lists which REST endpoint groups the system publishes, and verifies three preconditions: ' +
        'Accept-header handling (a broken one makes almost every call fail with HTTP 406 on BW 7.5), ' +
        'access to the ADT DataPreview service, and whether the BICS reporting resource is implemented. ' +
        'Call it before planning work on a system whose release you do not already know: the answer says which tool ' +
        'groups are available and which route to take where they are not — on classic BW, for instance, ' +
        'transformations, DTPs and the classic providers have no REST resource and are read with ' +
        'bw_read_metadata_tables instead. One call beats inferring the release from failed ones.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'bw_list_source_systems',
      description:
        'List logical source systems (LSYS) registered in the BW datasource structure. ' +
        'If source_system_type is provided, lists only source systems of that type (e.g. "ODP_SAP", "ODP_BW", "FILE"). ' +
        'If omitted, lists all source systems across all types. ' +
        'Returns each LSYS with name, description, source_system_type, status, self_url, and children_path ' +
        '(pass children_path directly to bw_list_datasources as the source_system argument).',
      inputSchema: {
        type: 'object',
        properties: {
          source_system_type: {
            type: 'string',
            description:
              'Optional source system type filter. Known values: ODP_BW, ODP_SAP, ODP_CDS, ODP, FILE. ' +
              'Omit to list all source systems.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_list_datasources',
      description:
        'List all DataSources (RSDS) available under a logical source system. ' +
        'Recursively traverses the full application component (APCO) hierarchy — may take time for large systems. ' +
        'Returns each DataSource with name, source_system, description, status, self_url, and apco_path ' +
        '(ordered list of application component titles from root to the DataSource). ' +
        'Optional apco_path_filter restricts the result to a hierarchy subtree and also prunes traversal.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact plain-text table. "raw": raw XML feed bodies from BW.',
          },
          apco_path_filter: {
            type: 'string',
            description:
              'Optional APCO hierarchy filter. A contiguous sequence of APCO names, "/"-style separated by ">". ' +
              'May start at any depth in the hierarchy (not root-anchored). Example: "LEVEL_1 > LEVEL_2" returns ' +
              'every DataSource that lives under a path containing LEVEL_1 directly followed by LEVEL_2. ' +
              'Each segment matches case-insensitively against the APCO display title OR the technical APCO name (trimmed). ' +
              'A single segment like "IS-U" returns all DataSources under any APCO subtree named "IS-U", at any depth.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_source_system',
      description:
        'Read the metadata of a single logical source system (LSYS) — type, description, connection details, and maintenance properties.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_datasource',
      description:
        'Read the full structure of a DataSource (RSDS) — metadata, all fields with types and properties, and adapter configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name of the DataSource (e.g. "DS_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['datasource_name', 'source_system'],
      },
    },
    {
      name: 'bw_change_datasource_delta',
      description:
        'Change the delta process of a DataSource (RSDS deltaProperties). Full read-modify-write; ' +
        'the requested value is validated against the DataSource\'s admissible delta values. ' +
        'Leaves the DataSource inactive — activate separately with bw_activate (object_type "rsds"). ' +
        'Pass delta_process as an empty string to remove the delta process.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name of the DataSource (e.g. "DATASOURCE_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Source system of the DataSource (compound key), e.g. "SOURCE_SYSTEM".',
          },
          delta_process: {
            type: 'string',
            description: 'Target delta process code (e.g. "FIL0"), or empty string for no delta.',
          },
        },
        required: ['datasource_name', 'source_system', 'delta_process'],
      },
    },
    {
      name: 'bw_set_datasource_fields',
      description:
        'Set the transfer flag of one or more DataSource fields (fieldProperties@transfer) ' +
        'and/or the segment language field designation. ' +
        'Full read-modify-write; only the field transfer flags and/or the segment languageField change. ' +
        'Fields marked transferNotAllowed are skipped when enabling transfer. ' +
        'At least one of fields / language_field must be given. ' +
        'Leaves the DataSource inactive — activate separately with bw_activate (object_type "rsds"). ' +
        'Pass transport for a transportable DataSource so the change is recorded on that request.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name of the DataSource (e.g. "DATASOURCE_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Source system of the DataSource (compound key), e.g. "SOURCE_SYSTEM".',
          },
          fields: {
            type: 'array',
            description: 'Fields to change and their target transfer flag.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Field name (e.g. "FIELD_NAME").' },
                transfer: { type: 'boolean', description: 'true to transfer the field, false to exclude it.' },
              },
              required: ['name', 'transfer'],
            },
          },
          language_field: {
            type: 'string',
            description:
              'Set to a field name (e.g. "FIELD_NAME") to designate the segment language field, ' +
              'set to "" to clear the designation. Clearing it fixes ODP text loads that abort with ' +
              '"Filter condition cannot be interpreted by DataSource" (RODPS_SAPI004). ' +
              'After the change, activate the DataSource with bw_activate (object_type "rsds").',
          },
          transport: {
            type: 'string',
            description: 'Transport request (e.g. DEVK900123). Required for a transportable DataSource; omit for local ($TMP).',
          },
        },
        required: ['datasource_name', 'source_system'],
      },
    },
    {
      name: 'bw_preview_datasource',
      description:
        'Fetch a live data preview / sample rows from a DataSource (RSDS) — ' +
        'reads the first N rows directly from the source system and returns them ' +
        'as a formatted table with field names as column headers. ' +
        'Use this when the user wants to see, sample, preview, or inspect the actual ' +
        'data behind a DataSource (e.g. "show me data from DS_X", "preview 50 rows", ' +
        '"what does DS_X look like"). ' +
        'For data from an aDSO, CompositeProvider, or BEx query, use bw_query_data instead.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'DataSource name (e.g. "DS_NAME"). Case-insensitive.',
          },
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
          records: {
            type: 'number',
            description: 'Number of records to fetch (default: 20). SAP returns at most this many rows.',
          },
        },
        required: ['datasource_name', 'source_system'],
      },
    },
    {
      name: 'bw_list_remote_entities',
      description:
        'List the remote entities (HANA views / virtual tables) a source system exposes as a ' +
        'DataSource basis — read-only discovery (the value help Eclipse shows on the DataSource ' +
        'proposal page). Each entity\'s technical_name is exactly what binds into bw_create_datasource ' +
        'as the HANA entity. Use this to find a valid hana_entity before creating a DataSource.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). A HANA/SDA/SDI source system.',
          },
          search_pattern: {
            type: 'string',
            description: 'Wildcard pattern filtering on technicalName (default "*" for all).',
          },
          result_size: {
            type: 'number',
            description: 'Maximum number of rows to return (default 200). Check result_complete to see if truncated.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_create_datasource',
      description:
        'Create a DataSource (RSDS) on top of a remote entity from the server\'s field proposal, ' +
        'leaving it inactive. The server derives the complete field/segment structure from the ' +
        'remote entity — no field, key, or partitioning editing is supported (v1). ' +
        'Local objects only (Development-Class $TMP); no transport handling. ' +
        'The HANA entity binds via the adapter externalObject attribute, not by name equality — ' +
        'use bw_list_remote_entities to find a valid hana_entity. ' +
        'After creation, activate separately with bw_activate (object_type "rsds", the same ' +
        'source_system, lock_handle "").',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name for the new DataSource (e.g. "DS_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). A HANA/SDA/SDI source system.',
          },
          application_component: {
            type: 'string',
            description: 'Application component (APCO) to file the DataSource under (e.g. "APCO_NAME").',
          },
          hana_entity: {
            type: 'string',
            description: 'Remote entity technical name (technicalName from bw_list_remote_entities), bound as the ' +
              'adapter externalObject. Defaults to datasource_name as a convenience; set independently when they differ. ' +
              'Case-sensitive — passed to the source as-is.',
          },
          description: {
            type: 'string',
            description: 'DataSource description (default: the hana_entity value).',
          },
        },
        required: ['datasource_name', 'source_system', 'application_component'],
      },
    },
    {
      name: 'bw_get_ckf',
      description:
        'Read a global Calculated Key Figure (CKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, formula (recursively resolved), metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the CKF (e.g. "CKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_rkf',
      description:
        'Read a global Restricted Key Figure (RKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, base measure, characteristic filters, metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the RKF (e.g. "RKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_structure',
      description:
        'Read a global Structure defined at CompositeProvider level. ' +
        'Returns the ordered member list with type (Selection/Formula), referenced component ' +
        'or IOBJ name, characteristic filters, and the full dependency graph.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the Structure (e.g. "STR_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_create_rkf',
      description:
        'Create one reusable Restricted Key Figure (RKF, TLOGO ELEM) on an InfoProvider. ' +
        'Built for mass creation: one RKF per call — the agent loops. The RKF is created from a ' +
        'base key figure plus one or more characteristic restrictions; each restriction value is ' +
        'validated against the InfoProvider and mapped to its internal key before the write. ' +
        'The RKF is written consistent (no separate activation step). ' +
        'All names must be technical names (e.g. "PROVIDER_NAME", "RKF_NAME", "KYF_NAME", "IOBJ_NAME").',
      inputSchema: {
        type: 'object',
        properties: {
          provider_name: {
            type: 'string',
            description: 'Technical name of the InfoProvider the RKF is built on (e.g. "PROVIDER_NAME").',
          },
          technical_name: {
            type: 'string',
            description:
              'Technical name of the RKF to create (e.g. "RKF_NAME"). Convention is typically ' +
              'PROVIDER_SUFFIX, but the name is free.',
          },
          description: {
            type: 'string',
            description: 'RKF description text.',
          },
          base_key_figure: {
            type: 'string',
            description: 'Technical name of the base key figure to restrict (e.g. an amount key figure "KYF_NAME").',
          },
          restrictions: {
            type: 'array',
            description: 'Characteristic restrictions applied to the base key figure. At least one is required.',
            items: {
              type: 'object',
              properties: {
                characteristic: {
                  type: 'string',
                  description: 'Technical name of the characteristic to restrict (e.g. "IOBJ_NAME").',
                },
                operator: {
                  type: 'string',
                  enum: ['Equal', 'Between', 'LessThan', 'GreaterThan', 'LessEqual', 'GreaterEqual', 'Contains'],
                  description: 'Comparison operator. Defaults to "Equal".',
                },
                values: {
                  type: 'array',
                  description:
                    'Restriction values. For "Equal" several values may be given (multiple tokens in the ' +
                    'same group). For "Between" every value needs both "low" and "high".',
                  items: {
                    type: 'object',
                    properties: {
                      low: { type: 'string', description: 'The (external) value, or the interval lower bound for "Between".' },
                      high: { type: 'string', description: 'Interval upper bound; only for operator "Between".' },
                    },
                    required: ['low'],
                  },
                },
                exclude: {
                  type: 'boolean',
                  description: 'When true, the restriction is an exclusion ("not equal to"). Defaults to false.',
                },
              },
              required: ['characteristic', 'values'],
            },
          },
          info_area: {
            type: 'string',
            description: 'Optional InfoArea (technical name). When omitted, no InfoArea is set.',
          },
          package: {
            type: 'string',
            description: 'Development package. Defaults to the local package (e.g. "$TMP").',
          },
          transport_request: {
            type: 'string',
            description:
              'Transport request number (e.g. DEVK900123). Only needed when package is transportable; ' +
              'omit for the local package.',
          },
        },
        required: ['provider_name', 'technical_name', 'description', 'base_key_figure', 'restrictions'],
      },
    },
    {
      name: 'bw_query_data',
      description:
        'Execute a BW query or preview data from a provider (CompositeProvider, aDSO, etc.) via the BICS reporting endpoint. ' +
        'ALWAYS call the appropriate read tool first before querying data: ' +
        'bw_get_composite_provider for a CompositeProvider (is_provider=true), ' +
        'bw_get_adso for an aDSO (is_provider=true), ' +
        'bw_get_query for a BEx Query — this gives you the available fields, key figures, ' +
        'and the query structure before you attempt a data call. ' +
        'Then perform a GET (no state/variables) first to discover the current axis layout, ' +
        'characteristic ids, variables, and background filters before sending any POST. ' +
        'IMPORTANT — always call bw_get_filter_values before applying any filter or variable value. ' +
        'This is the only way to know the correct internal key format for a characteristic ' +
        '(e.g. date/time characteristics like 0CALMONTH, 0CALYEAR, 0CALDAY may use non-obvious formats). ' +
        'Never guess or assume filter value formats — always look them up first. ' +
        'If the GET response shows inputRequired="true", variables must be filled via POST before data is available. ' +
        'If unsure whether a BEx Query exists for the desired analysis, use bw_search or bw_list_contents first ' +
        'before falling back to a direct provider call (is_provider=true). ' +
        'Result is rendered as a formatted table with hierarchy indentation. ' +
        'KEY FIGURE STRUCTURE FILTER: to restrict which key figures appear in the result, apply filterValues ' +
        'directly on the structure dimension (isStructure=true) in state.infoObjects — use the technical name ' +
        'of the calculated or restricted key figure as the low value (e.g. "CKF_NAME" or "RKF_NAME"). ' +
        'Hierarchical children of the filtered member are included automatically. ' +
        'This is the correct approach because ad-hoc threshold filters on key figure values are not supported ' +
        'via the state mechanism; only structure-member selection is possible this way. ' +
        'CRITICAL: variable id and name values in the variablesContainer are session-specific ' +
        'and change between GET calls. Always extract variable id and name exactly from the ' +
        'variablesContainer in the GET response and use them immediately in the next POST — ' +
        'never reuse IDs from a previous GET call or from bw_get_query output. ' +
        'The variable name includes trailing spaces and a 4-digit suffix (e.g. "VARNAME                       0004") ' +
        'that must be copied verbatim from the GET response. ' +
        'format="raw" returns XML.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_id: {
            type: 'string',
            description: 'BEx Query name or InfoProvider name (ADSO, HCPR, etc.) to query.',
          },
          is_provider: {
            type: 'boolean',
            description:
              'Set to true when comp_id is an InfoProvider name (CompositeProvider, aDSO, etc.) ' +
              'rather than a BEx Query name. Adds the required "!" prefix to the compid URL parameter. ' +
              'If unsure whether a query exists for the desired analysis, use bw_search or ' +
              'bw_list_contents first to check before falling back to a direct provider call.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default): structured human-readable output. "raw": raw XML response body.',
          },
          state: {
            type: 'object',
            description:
              'Axis layout and optional per-characteristic filters. ' +
              'All InfoObjects from the query must be listed (even those staying on FREE axis). ' +
              'id values must come from the GET metadata response.',
            properties: {
              infoObjects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'InfoObject technical name.' },
                    id: { type: 'string', description: 'id from the GET metadata response.' },
                    axis: { type: 'string', enum: ['ROWS', 'COLUMNS', 'FREE'], description: 'Target axis.' },
                    hierarchy: {
                      type: 'object',
                      description:
                        'Active hierarchy for this characteristic. Required when filtering by hierarchy node (nodeId=1). ' +
                        'Copy id, name, hryId, hryDateFrom, hryDateTo from the <hierarchy> element in the GET response.',
                      properties: {
                        id: { type: 'string', description: 'Hierarchy id attribute from GET response.' },
                        name: { type: 'string', description: 'Hierarchy name (technical name).' },
                        hryId: { type: 'string', description: 'hryId attribute (display name / variant).' },
                        hryDateFrom: { type: 'string', description: 'Validity from date (YYYYMMDD). Defaults to 00000000.' },
                        hryDateTo: { type: 'string', description: 'Validity to date (YYYYMMDD). Defaults to 99991231.' },
                      },
                      required: ['id', 'name', 'hryId'],
                    },
                    filterValues: {
                      type: 'array',
                      description:
                        'Optional filter selections for this characteristic. ' +
                        'Also works on structure dimensions (isStructure=true on ROWS or COLUMNS): ' +
                        'set low to the technical name of a key figure, calculated key figure, or restricted key figure ' +
                        '(e.g. "CKF_NAME") to restrict the result to that structure member and its children. ' +
                        'This is the only supported way to filter by key figure in BICS.',
                      items: {
                        type: 'object',
                        properties: {
                          low: { type: 'string', description: 'Filter value in external key format (e.g. altName or CHAVL_EXT). Use this for members that have a named external key.' },
                          lowInt: { type: 'string', description: 'Filter value in internal key format (e.g. GUID like 00O2...). Use when the member has no altName and only an internal GUID is known. Sends presentationMode="INT" in BICS XML.' },
                          lowText: { type: 'string', description: 'Display text for the value (optional).' },
                          high: { type: 'string', description: 'Upper bound for interval operator BT.' },
                          op: { type: 'string', description: 'Operator: EQ (default), BT, GT, LT, GE, LE.' },
                          sign: { type: 'string', description: 'I=include (default), E=exclude.' },
                          nodeId: { type: 'number', description: 'Node selection mode: 0=leaf member (default), 1=hierarchy node (use when filtering a collapsed hierarchy node like a group).' },
                        },
                      },
                    },
                  },
                  required: ['name', 'id', 'axis'],
                },
              },
            },
            required: ['infoObjects'],
          },
          variables: {
            type: 'array',
            description:
              'Variable values to fill. name must match exactly as returned by GET (may contain trailing spaces). ' +
              'id and other metadata fields come from the GET variablesContainer response.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Variable technical name (exact, including trailing spaces).' },
                id: { type: 'string', description: 'Variable id from the GET response.' },
                txt: { type: 'string', description: 'Variable label (optional, for readability).' },
                altName: { type: 'string', description: 'altName from the GET response (optional).' },
                type: { type: 'string', description: 'Variable type (default "charMember").' },
                inputEnabled: { type: 'boolean', description: 'Whether the variable accepts input (default true).' },
                mandatory: { type: 'boolean', description: 'Whether the variable is mandatory.' },
                iobj: { type: 'string', description: 'InfoObject the variable is based on.' },
                values: {
                  type: 'array',
                  description: 'List of select values to assign.',
                  items: {
                    type: 'object',
                    properties: {
                      low: { type: 'string', description: 'Value (CHAVL_INT internal key format).' },
                      high: { type: 'string', description: 'Upper bound for interval (op=BT).' },
                      op: { type: 'string', description: 'Operator: EQ (default) or BT.' },
                      sign: { type: 'string', description: 'I=include (default).' },
                    },
                    required: ['low'],
                  },
                },
              },
              required: ['name', 'id', 'values'],
            },
          },
          from_row: {
            type: 'number',
            description: 'Start row for pagination (default 0).',
          },
          to_row: {
            type: 'number',
            description: 'End row for pagination (default 1000).',
          },
          drill_operations: {
            type: 'array',
            description:
              'Optional. Expand or collapse hierarchy nodes or key figure structure nodes in the current result. ' +
              'Each operation targets one node by its 1-based tuple index. ' +
              'drill_state: 3 = expand, 2 = collapse. ' +
              'element_idx: which dimension within the tuple (1 = first, 2 = second, etc.) — ' +
              'use 2 when ROWS has multiple dimensions and the target node is on the second one. ' +
              'Requires the full state and variables to be sent again in the same POST (stateless endpoint). ' +
              'Use after an initial bw_query_data call to drill into a collapsed structure node or hierarchy node.',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
                drill_state: { type: 'number', description: '3 = expand, 2 = collapse.' },
                tuple_idx: { type: 'number', description: '1-based index of the tuple in the current result.' },
                element_idx: { type: 'number', description: '1-based index of the dimension within the tuple.' },
              },
              required: ['axis', 'drill_state', 'tuple_idx', 'element_idx'],
            },
          },
        },
        required: ['comp_id'],
      },
    },
    {
      name: 'bw_get_filter_values',
      description:
        'Look up valid characteristic values for use in query filters or variable inputs. ' +
        'Returns CHAVL_INT (internal key) — always use this value when setting filter selectValues or variable inputs; ' +
        'CHAVL_EXT and CHAVL_INT often differ for date-type characteristics. ' +
        'Supports wildcard search: use "*" to return all values, "2022*" for prefix match. ' +
        'Optionally scope results to a specific InfoProvider (recommended when values differ by provider).',
      inputSchema: {
        type: 'object',
        properties: {
          characteristic_name: {
            type: 'string',
            description: 'InfoObject technical name to get values for (e.g. "IOBJ_NAME").',
          },
          search_string: {
            type: 'string',
            description: 'Wildcard search pattern. "*" returns all values up to max_rows. Prefix with text to filter (e.g. "2022*").',
          },
          info_provider: {
            type: 'string',
            description: 'Optional. Scopes the value list to a specific InfoProvider (ADSO, HCPR, etc.). Omit to read from master data directly.',
          },
          max_rows: {
            type: 'number',
            description: 'Maximum number of values to return (default 201).',
          },
        },
        required: ['characteristic_name', 'search_string'],
      },
    },
    {
      name: 'bw_get_roles',
      description:
        'Load the complete BW query role hierarchy as shown in the "Publish to Role" dialog. ' +
        'Returns all roles (ROLE nodes) and their folder structure (FOLDER nodes) with nodeids. ' +
        'Use this to discover role names and folder names needed for bw_set_query_roles. ' +
        'Optionally filter to roles whose name starts with a given prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          role_filter: {
            type: 'string',
            description: 'Optional prefix to filter results. Only ROLE nodes whose name starts with this prefix are included (e.g. "BW:").',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_query_roles',
      description:
        'Get all roles and folders where a specific BW query is currently published. ' +
        'Returns the role name, description, and folder for each assignment. ' +
        'If the query is not published anywhere, returns a clear message.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the BW query (case-insensitive).',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_set_query_roles',
      description:
        'Publish or unpublish a BW query in a role or folder. ' +
        'action "add": assigns the query to the given role or folder. ' +
        'action "remove": removes the query from the given role or folder. ' +
        'Use bw_get_roles to discover role/folder names and bw_get_query_roles to see current assignments.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the BW query (case-insensitive).',
          },
          action: {
            type: 'string',
            enum: ['add', 'remove'],
            description: '"add" to publish, "remove" to unpublish.',
          },
          target_name: {
            type: 'string',
            description:
              'For target_type "role": the name attribute of the ROLE node (e.g. from bw_get_roles). ' +
              'For target_type "folder": the txt (display name) of the FOLDER node.',
          },
          target_type: {
            type: 'string',
            enum: ['role', 'folder'],
            description: '"role" to assign at role level, "folder" to assign into a specific subfolder.',
          },
          parent_role_name: {
            type: 'string',
            description: 'Required when target_type is "folder". The name attribute of the parent ROLE node that contains the target folder.',
          },
        },
        required: ['query_name', 'action', 'target_name', 'target_type'],
      },
    },
    {
      name: 'bw_get_role_queries',
      description:
        'List all BW queries published in BW roles (via the "Publish to Role" mechanism). ' +
        'Returns each role with its assigned queries, including technical name, description, object type, and InfoProvider. ' +
        'Note: only SAP_BW_QUERY objects are returned; PFCG menu entries of other types (e.g. AFO workbooks added as transactions) are not included. ' +
        'Use role_name to filter to a specific role; omit it to see all roles with published queries.',
      inputSchema: {
        type: 'object',
        properties: {
          role_name: {
            type: 'string',
            description: 'Optional. Technical name of the role to filter by (e.g. from bw_get_roles). Omit to return all roles.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_dataflow',
      description:
        'Trace the data flow graph for a BW object. ' +
        'Returns a tree (≤ 30 nodes) or flat table (> 30 nodes) showing all connected objects ' +
        '(ADSO, RSDS, TRFN, DTPA, TRCS, IOBJ, HCPR, LSYS, ELEM) with their type, name, description, and status. ' +
        'BW direction convention: "upwards" traverses towards BW target objects (ADSO, TRFN, TRCS, IOBJ); ' +
        '"downwards" traverses towards source systems (LSYS, RSDS). ' +
        'Use this to understand the full lineage of an object without navigating each connection manually. ' +
        'IMPORTANT: Always print the complete tool result verbatim as a fenced code block in your chat response — never omit or summarize it.',
      inputSchema: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'Technical name of the BW object (e.g. "ADSO_NAME", "DS_NAME").',
          },
          object_type: {
            type: 'string',
            description: 'BW object type: ADSO, RSDS, HCPR, TRFN, DTPA, IOBJ, TRCS, LSYS.',
          },
          source_system: {
            type: 'string',
            description: 'Required when object_type is RSDS. Logical source system name (e.g. "LSYS_NAME").',
          },
          direction: {
            type: 'string',
            enum: ['upwards', 'downwards', 'both'],
            description: 'Direction to traverse: "upwards" (towards BW target objects: ADSO, TRFN, TRCS, IOBJ), "downwards" (towards source systems: LSYS, RSDS), or "both". Default "both".',
          },
          levels: {
            type: 'number',
            description: 'Number of levels to expand in each direction. -1 = all levels (default).',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): tree or flat table. "raw": raw XML from BW.',
          },
        },
        required: ['object_name', 'object_type'],
      },
    },
    {
      name: 'bw_get_open_hub',
      description:
        'Read an Open Hub Destination (TLOGO DEST) definition — destination type, source, ' +
        'DB table, InfoArea, package, status, the complete output field list with type/length, ' +
        'InfoObject binding, conversion routine, compounding, and key flag, ' +
        'plus file properties when the destination type is FILE.',
      inputSchema: {
        type: 'object',
        properties: {
          open_hub_name: {
            type: 'string',
            description: 'Technical name of the Open Hub Destination (e.g. "OBJECT_NAME").',
          },
        },
        required: ['open_hub_name'],
      },
    },
    {
      name: 'bw_get_aggregation_level',
      description:
        'Read an Aggregation Level (TLOGO ALVL) definition — the planning-enabled view on top of ' +
        'an InfoProvider (aDSO or CompositeProvider) used for Integrated Planning / embedded BPC. ' +
        'Returns name, description, status, InfoArea, package, the underlying InfoProvider, ' +
        'and the full element list split into characteristics and key figures. ' +
        'Characteristics include type, length, conversion routine, base InfoObject, compounding, and dimension group. ' +
        'Key figures additionally include aggregation behavior, semantics (AMO/QUA/NUM), ' +
        'and the unit/currency reference (unit characteristic, fixed unit, or fixed currency).',
      inputSchema: {
        type: 'object',
        properties: {
          aggregation_level_name: {
            type: 'string',
            description: 'Technical name of the Aggregation Level (e.g. "OBJECT_NAME").',
          },
        },
        required: ['aggregation_level_name'],
      },
    },
    {
      name: 'bw_create_aggregation_level',
      description:
        'Create a new Aggregation Level (TLOGO ALVL) on top of a planning-enabled InfoProvider ' +
        '(aDSO or CompositeProvider), for Integrated Planning / embedded BPC. ' +
        'Sequence: lock → POST the shell → unlock → lock → PUT the field list → unlock. ' +
        'The Aggregation Level is created inactive — activate it with bw_activate using ' +
        'object_type "alvl" and lock_handle "". ' +
        'By default every characteristic and key figure of the InfoProvider is exposed; pass ' +
        'fields to restrict the selection. A selection needs at least one characteristic and one ' +
        'key figure, and it must contain every key field of the underlying provider, otherwise ' +
        'activation reports the missing ones. ' +
        'The InfoProvider must be planning-enabled, otherwise the create fails with a message ' +
        'saying it cannot serve as the basis of an aggregation level.',
      inputSchema: {
        type: 'object',
        properties: {
          aggregation_level_name: {
            type: 'string',
            description: 'Technical name of the new Aggregation Level (e.g. "OBJECT_NAME").',
          },
          label: {
            type: 'string',
            description: 'Description of the Aggregation Level.',
          },
          info_area: {
            type: 'string',
            description: 'InfoArea the Aggregation Level is created in (e.g. "AREA_NAME").',
          },
          info_provider: {
            type: 'string',
            description:
              'Technical name of the underlying planning-enabled InfoProvider — an aDSO or a ' +
              'CompositeProvider (e.g. "OBJECT_NAME").',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Characteristics and key figures to expose, by their name on the InfoProvider ' +
              '(e.g. ["FIELD_NAME", "IOBJ_NAME"]). Omit to expose every field of the provider. ' +
              'Read the provider with bw_get_adso or bw_get_composite_provider to see the names. ' +
              'On a CompositeProvider the fields carry a generated prefix ("<prefix>-FIELD_NAME"); ' +
              'both that form and the bare name are accepted.',
          },
          package: {
            type: 'string',
            description: 'Development package. Defaults to "$TMP" (local, not transported).',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
        },
        required: ['aggregation_level_name', 'label', 'info_area', 'info_provider'],
      },
    },
    {
      name: 'bw_update_aggregation_level',
      description:
        'Add fields to or remove fields from an existing Aggregation Level (TLOGO ALVL). ' +
        'action "add_fields" exposes further characteristics or key figures of the underlying ' +
        'InfoProvider; action "remove_fields" drops them from the Aggregation Level. ' +
        'Fields already exposed (add) or not exposed at all (remove) are reported as skipped, ' +
        'not treated as errors. ' +
        'The Aggregation Level becomes inactive — activate it with bw_activate using ' +
        'object_type "alvl" and lock_handle "". ' +
        'A removal that would leave no characteristic or no key figure is refused before writing. ' +
        'On a CompositeProvider both the prefixed field name and the bare name are accepted.',
      inputSchema: {
        type: 'object',
        properties: {
          aggregation_level_name: {
            type: 'string',
            description: 'Technical name of the Aggregation Level (e.g. "OBJECT_NAME").',
          },
          action: {
            type: 'string',
            enum: ['add_fields', 'remove_fields'],
            description: 'Defaults to "add_fields".',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Fields to add or remove (e.g. ["FIELD_NAME", "IOBJ_NAME"]). Names are resolved ' +
              'against the underlying InfoProvider.',
          },
          transport: {
            type: 'string',
            description: 'Transport request number. Required on systems with transport obligation.',
          },
        },
        required: ['aggregation_level_name', 'fields'],
      },
    },
    {
      name: 'bw_get_planning_function',
      description:
        'Read a Planning Function (TLOGO PLSE) definition — a planning operation ' +
        '(formula/FOX, copy, delete, repost, distribution, currency translation, custom exit, …) ' +
        'tied to an aggregation level for Integrated Planning / embedded BPC. ' +
        'Returns name, description, function type (planningServiceType), aggregation level, ' +
        'documentation, status, InfoArea, package, the characteristic usage list ' +
        '(role of each characteristic in the function), and the full parameter tree ' +
        'with nested structure and values. For FORMULA functions the FOX code surfaces ' +
        'as the value of the FLINE parameter.',
      inputSchema: {
        type: 'object',
        properties: {
          planning_function_name: {
            type: 'string',
            description: 'Technical name of the Planning Function (e.g. "OBJECT_NAME").',
          },
        },
        required: ['planning_function_name'],
      },
    },
    {
      name: 'bw_get_planning_sequence',
      description:
        'Read a Planning Sequence (TLOGO PLSQ) definition — an ordered list of planning steps ' +
        'for Integrated Planning / embedded BPC. Returns name, description, InfoArea, package, ' +
        'status, and the ordered step list. Each step shows its type code, the aggregation level, ' +
        'the planning function (planning service), and the filter name.',
      inputSchema: {
        type: 'object',
        properties: {
          planning_sequence_name: {
            type: 'string',
            description: 'Technical name of the Planning Sequence (e.g. "OBJECT_NAME").',
          },
        },
        required: ['planning_sequence_name'],
      },
    },
    {
      name: 'bw_get_planning_properties',
      description:
        'Read the Planning Properties (TLOGO PLCR) of a plan-enabled InfoProvider (real-time aDSO or ' +
        'CompositeProvider). Returns the provider name, underlying provider resource and media type, ' +
        'InfoArea, package, status, and the general planning settings: key-date mode, maximum number ' +
        'of characteristic combinations, and the save strategy (planning sequence and delta-read flag). ' +
        'The PLCR shares its technical name with the InfoProvider it belongs to.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_provider_name: {
            type: 'string',
            description: 'Technical name of the plan-enabled InfoProvider (e.g. "OBJECT_NAME"). ' +
              'The PLCR object shares this name.',
          },
        },
        required: ['plan_provider_name'],
      },
    },
    {
      name: 'bw_list_process_chain_runs',
      description:
        'List execution runs of one or all process chains from the process chain monitoring log. ' +
        'Each row represents one chain run with overall status, runtime deviation, start/end timestamps, and duration. ' +
        'Optionally filter by chain technical name, start date range, and status code. ' +
        'Returns the log_id of each run — pass chain_id + log_id into bw_get_process_chain_run_detail for step-level details. ' +
        'Ordered by start time descending. Default limit 20 runs.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Optional process chain technical name to restrict to runs of a single chain (e.g. "CHAIN_NAME"). Omit for system-wide results.',
          },
          date_from: {
            type: 'string',
            description: 'Optional lower bound for run start date (ISO format, e.g. "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"). Maps to startDate ge datetime filter.',
          },
          date_to: {
            type: 'string',
            description: 'Optional upper bound for run start date (ISO format). Maps to startDate le datetime filter.',
          },
          status: {
            type: 'string',
            description: 'Optional status code filter (e.g. as returned by the status field of previous runs). Resolves to eq filter on the status field.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of runs to return (default 20).',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_process_chain_run_detail',
      description:
        'Read the execution detail of one process chain run — all process steps with type, variant, status, ' +
        'timestamps, and parent/child relationships (predecessor graph edges), plus the full message log. ' +
        'chain_id and log_id come from bw_list_process_chain_runs or bw_list_process_chain_last_status output. ' +
        'Use this to diagnose a failed run: the message log contains the actual error messages.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME").',
          },
          log_id: {
            type: 'string',
            description: 'Run log ID from bw_list_process_chain_runs or bw_list_process_chain_last_status (logId field).',
          },
        },
        required: ['chain_id', 'log_id'],
      },
    },
    {
      name: 'bw_list_process_chain_last_status',
      description:
        'Read the latest execution status and scheduling state for every process chain in the system — ' +
        'one row per chain. Includes last run status, runtime deviation, scheduling status, next scheduled start, ' +
        'and the log_id of the most recent run (pass into bw_get_process_chain_run_detail to drill down). ' +
        'Chains that have never run appear here too. ' +
        'Optionally filter to chains whose last run has a specific status or whose last start date falls in a range.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Optional filter on last run status code. Returns only chains whose most recent run matches this status.',
          },
          last_start_from: {
            type: 'string',
            description: 'Optional lower bound for last run start date (ISO format, e.g. "YYYY-MM-DD"). Maps to lastStartDate ge datetime filter.',
          },
          last_start_to: {
            type: 'string',
            description: 'Optional upper bound for last run start date (ISO format). Maps to lastStartDate le datetime filter.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of chains to return. Omit to return all.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_create_process_chain',
      description:
        'Create a Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Builds the chain model from a list of steps and edges, creates it with a trigger-only skeleton, ' +
        'then updates it with the full model in a single operation. Optionally activates after creation. ' +
        'The TRIGGER (Start) node is implicit (node index 0) and must not be listed in steps. ' +
        'DTP_LOAD and generic referenced steps use bIsReference=true; ADSOACT and ADSOREM use inline variants. ' +
        'Collectors (AND, OR, XOR) require no extra fields beyond their type. ' +
        'Edge status defaults: neutral for edges whose source is TRIGGER or a collector; positive for all others. ' +
        'For two-step DTP loading always use bw_create_dtp first; this tool builds the process chain around existing DTPs. ' +
        'Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), ABAP (execute an ABAP program, optionally with an SE38 selection variant), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. ' +
        'A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. ' +
        'Other inline-configuration process types (for example OS command, attribute change run) are not supported in this version. ' +
        'Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. ' +
        'DECISION branch edges: set sub_status to the branch EVENTNO ("01"=THEN/JA, "02"=ELSE/NEIN) — such edges are always positive. Create the referenced decision variant first with bw_create_decision_variant. ' +
        'To start the chain on an event instead of immediately, pass trigger_event (start type "E").',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name, uppercase, max 30 characters (e.g. "CHAIN_NAME").',
          },
          infoarea: {
            type: 'string',
            description: 'InfoArea to file the chain under (e.g. "AREA_NAME").',
          },
          description: {
            type: 'string',
            description: 'Short description / label for the process chain.',
          },
          steps: {
            type: 'array',
            description:
              'Ordered list of steps. The TRIGGER (Start) node is implicit at index 0 — do not include it here. ' +
              'Each step has a caller-chosen id used for edge wiring. ' +
              'Step types: DTP_LOAD (requires dtp field), ADSOACT (requires datastores array), ADSOREM (requires remDatastores array), ' +
              'ABAP (requires program field, optional program_variant), ' +
              'CHAIN (requires object = sub-chain name), DECISION (requires variant = decision variant name), AND / OR / XOR (collector, no extra fields), or any other BW process type (requires object field).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Caller-chosen identifier used to reference this step in edges (e.g. "step1").' },
                type: {
                  type: 'string',
                  description: 'Process type: "DTP_LOAD", "ADSOACT", "ADSOREM", "ABAP", "CHAIN", "DECISION", "AND", "OR", "XOR", or any BW process type string.',
                },
                dtp: { type: 'string', description: 'DTP technical name. Required when type is "DTP_LOAD" (e.g. "DTP_...").' },
                variant: { type: 'string', description: 'Decision variant technical name to reference. Required when type is "DECISION". Create it first with bw_create_decision_variant.' },
                description: { type: 'string', description: 'Step display description (used for DTP_LOAD, CHAIN, DECISION, and generic referenced steps).' },
                datastores: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of aDSO technical names to activate. Required when type is "ADSOACT".',
                },
                requestsSequential: {
                  type: 'boolean',
                  description: 'ADSOACT only. Activate requests sequentially (NOCONDENSE). Default false.',
                },
                errorOnNonActivation: {
                  type: 'boolean',
                  description: 'ADSOACT only. Error on non-activation of loaded requests (NOREQACTWARN). Default false.',
                },
                remDatastores: {
                  type: 'array',
                  description: 'Required when type is "ADSOREM" (DSO request cleanup). One entry per aDSO whose requests to clean up, each with its own cleanup action and request selection.',
                  items: {
                    type: 'object',
                    properties: {
                      datastore: { type: 'string', description: 'aDSO technical name (e.g. "ADSO_NAME").' },
                      action: { type: 'string', description: 'Cleanup action code from the cockpit "Bereinigungsaktion" dropdown (single character). Observed: "A" = activate requests, "C" = remove old requests from the change log. The valid action depends on the aDSO type; an unsuitable action is rejected at activation.' },
                      allRequests: { type: 'boolean', description: 'Clean up all requests (ALL_REQUESTS). When true, the count/age selectors are ignored. Default false.' },
                      numberRequests: { type: 'number', description: 'Keep the last N requests (NUMBER_REQUESTS); older ones are removed. Default 0.' },
                      numberDays: { type: 'number', description: 'Remove requests older than N days (NUMBER_DAYS). Default 0.' },
                      packageSize: { type: 'number', description: 'Processing package size (PACKAGE_SIZE); 0 = server default.' },
                    },
                  },
                },
                program: {
                  type: 'string',
                  description: 'ABAP program / report to execute (e.g. "REPORT_NAME"). Required when type is "ABAP". The call is stored as an inline variant in the chain — no separate variant object is created.',
                },
                program_variant: {
                  type: 'string',
                  description: 'ABAP only. Optional ABAP report (SE38) selection variant name (e.g. "VARIANT_NAME"). Note this is a report variant, not the DECISION variant field above.',
                },
                program_package: {
                  type: 'string',
                  description: 'ABAP only. Optional package of the report (cosmetic value-help enrichment; the server re-derives it when omitted).',
                },
                program_description: {
                  type: 'string',
                  description: 'ABAP only. Optional report description (cosmetic).',
                },
                variant_description: {
                  type: 'string',
                  description: 'ABAP only. Optional report-variant description (cosmetic).',
                },
                synchronous: {
                  type: 'boolean',
                  description: 'ABAP only. Call mode. true (default) runs the program synchronously (X_SYNCHRON). Only the default is verified.',
                },
                local: {
                  type: 'boolean',
                  description: 'ABAP only. Call location. true (default) runs the program on this system (X_LOCAL). Only the default is verified.',
                },
                object: {
                  type: 'string',
                  description: 'Technical name of the referenced BW object. Required for CHAIN (sub-chain name) and other generic referenced step types (any type other than DTP_LOAD, ADSOACT, ADSOREM, ABAP, AND, OR, XOR).',
                },
              },
              required: ['id', 'type'],
            },
          },
          edges: {
            type: 'array',
            description:
              'Directed edges connecting steps. Use the step id or the literal "TRIGGER" for the start node. ' +
              'Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. ' +
              'For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive".',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source step id or "TRIGGER".' },
                to: { type: 'string', description: 'Target step id or "TRIGGER".' },
                status: {
                  type: 'string',
                  enum: ['neutral', 'positive', 'negative'],
                  description: 'Edge condition. Omit to use the default (see above).',
                },
                sub_status: {
                  type: 'string',
                  description: 'Branch condition (DECISION out-edges only): the branch EVENTNO, e.g. "01" (THEN/JA) or "02" (ELSE/NEIN). Defaults to "00" (normal edge).',
                },
              },
              required: ['from', 'to'],
            },
          },
          trigger_event: {
            type: 'object',
            description:
              'Optional event start-condition for the trigger (start type "E"). Omit for the default immediate start (start type "I").',
            properties: {
              event_id: { type: 'string', description: 'Event id, e.g. "SAP_TEST".' },
              event_parameter: { type: 'string', description: 'Event parameter. Defaults to the chain name when omitted.' },
              event_type: { type: 'string', description: 'Event type. Defaults to "OtherEvent".' },
              only_once: { type: 'boolean', description: 'Start only once. Default false.' },
            },
            required: ['event_id'],
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after creation. Default false.',
          },
        },
        required: ['name', 'infoarea', 'description', 'steps', 'edges'],
      },
    },
    {
      name: 'bw_update_process_chain',
      description:
        'Replace the step model (nodes and edges) of an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Reads the current chain to obtain the ETag and preserve the existing trigger node (with its scheduling configuration) ' +
        'and the current header. Replaces only the steps and edges; the trigger is always preserved as-is. ' +
        'Optionally overrides description and infoarea in the header. ' +
        'Optionally activates after the update. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly. ' +
        'Use bw_create_process_chain to create a new chain; use this tool to update an existing one. ' +
        'This tool REPLACES the whole step model, so every step that should survive must be listed — a step left out is deleted. ' +
        'For a small change to a big chain prefer the targeted tools (bw_append_process_chain_dtp, bw_add_process_chain_program, bw_add_process_chain_edge, bw_remove_process_chain_edge, bw_remove_process_chain_step), which edit the server\'s own model in place and cannot drop a step they do not model. ' +
        'Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), ABAP (execute an ABAP program, optionally with an SE38 selection variant), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. ' +
        'A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. ' +
        'Other inline-configuration process types (for example OS command, attribute change run) are not supported in this version — a chain containing one cannot be rewritten with this tool without losing that step. ' +
        'Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. ' +
        'DECISION branch edges: set sub_status to the branch EVENTNO ("01"/"02"); such edges are always positive. ' +
        'The trigger is preserved as-is unless trigger_event is passed (which sets an event start-condition); an existing event start-condition is preserved across updates.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          description: {
            type: 'string',
            description: 'Optional new description. If omitted, the existing chain description is kept.',
          },
          infoarea: {
            type: 'string',
            description: 'Optional new InfoArea. If omitted, the existing InfoArea is kept.',
          },
          steps: {
            type: 'array',
            description:
              'Complete replacement step list. The TRIGGER (Start) node is implicit at index 0 — do not include it here. ' +
              'Same shape as in bw_create_process_chain.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Caller-chosen identifier used to reference this step in edges.' },
                type: {
                  type: 'string',
                  description: 'Process type: "DTP_LOAD", "ADSOACT", "ADSOREM", "ABAP", "CHAIN", "DECISION", "AND", "OR", "XOR", or any BW process type string.',
                },
                dtp: { type: 'string', description: 'DTP technical name. Required when type is "DTP_LOAD".' },
                variant: { type: 'string', description: 'Decision variant technical name to reference. Required when type is "DECISION".' },
                description: { type: 'string', description: 'Step display description (DTP_LOAD, CHAIN, DECISION, and generic referenced steps).' },
                datastores: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'aDSO technical names to activate. Required when type is "ADSOACT".',
                },
                requestsSequential: {
                  type: 'boolean',
                  description: 'ADSOACT only. Activate requests sequentially (NOCONDENSE). Default false.',
                },
                errorOnNonActivation: {
                  type: 'boolean',
                  description: 'ADSOACT only. Error on non-activation of loaded requests (NOREQACTWARN). Default false.',
                },
                remDatastores: {
                  type: 'array',
                  description: 'Required when type is "ADSOREM" (DSO request cleanup). One entry per aDSO whose requests to clean up, each with its own cleanup action and request selection.',
                  items: {
                    type: 'object',
                    properties: {
                      datastore: { type: 'string', description: 'aDSO technical name (e.g. "ADSO_NAME").' },
                      action: { type: 'string', description: 'Cleanup action code from the cockpit "Bereinigungsaktion" dropdown (single character). Observed: "A" = activate requests, "C" = remove old requests from the change log. The valid action depends on the aDSO type; an unsuitable action is rejected at activation.' },
                      allRequests: { type: 'boolean', description: 'Clean up all requests (ALL_REQUESTS). When true, the count/age selectors are ignored. Default false.' },
                      numberRequests: { type: 'number', description: 'Keep the last N requests (NUMBER_REQUESTS); older ones are removed. Default 0.' },
                      numberDays: { type: 'number', description: 'Remove requests older than N days (NUMBER_DAYS). Default 0.' },
                      packageSize: { type: 'number', description: 'Processing package size (PACKAGE_SIZE); 0 = server default.' },
                    },
                  },
                },
                program: {
                  type: 'string',
                  description: 'ABAP program / report to execute (e.g. "REPORT_NAME"). Required when type is "ABAP". The call is stored as an inline variant in the chain — no separate variant object is created. Re-specify every existing ABAP step here, otherwise the replacement drops it; read the current program and report variant from bw_get_process_chain.',
                },
                program_variant: {
                  type: 'string',
                  description: 'ABAP only. Optional ABAP report (SE38) selection variant name (e.g. "VARIANT_NAME"). Note this is a report variant, not the DECISION variant field above. Omitting it on an existing step silently drops the step\'s selection variant.',
                },
                program_package: {
                  type: 'string',
                  description: 'ABAP only. Optional package of the report (cosmetic value-help enrichment; the server re-derives it when omitted).',
                },
                program_description: {
                  type: 'string',
                  description: 'ABAP only. Optional report description (cosmetic).',
                },
                variant_description: {
                  type: 'string',
                  description: 'ABAP only. Optional report-variant description (cosmetic).',
                },
                synchronous: {
                  type: 'boolean',
                  description: 'ABAP only. Call mode. true (default) runs the program synchronously (X_SYNCHRON). Only the default is verified.',
                },
                local: {
                  type: 'boolean',
                  description: 'ABAP only. Call location. true (default) runs the program on this system (X_LOCAL). Only the default is verified.',
                },
                object: {
                  type: 'string',
                  description: 'Technical name of the referenced BW object. Required for generic referenced step types.',
                },
              },
              required: ['id', 'type'],
            },
          },
          edges: {
            type: 'array',
            description:
              'Complete replacement edge list. Use the step id or the literal "TRIGGER" for the start node. ' +
              'Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. ' +
              'For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive".',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source step id or "TRIGGER".' },
                to: { type: 'string', description: 'Target step id or "TRIGGER".' },
                status: {
                  type: 'string',
                  enum: ['neutral', 'positive', 'negative'],
                  description: 'Edge condition. Omit to use the default.',
                },
                sub_status: {
                  type: 'string',
                  description: 'Branch condition (DECISION out-edges only): the branch EVENTNO, e.g. "01" (THEN/JA) or "02" (ELSE/NEIN). Defaults to "00" (normal edge).',
                },
              },
              required: ['from', 'to'],
            },
          },
          trigger_event: {
            type: 'object',
            description:
              'Optional event start-condition for the trigger (start type "E"). When omitted, an existing event start-condition is preserved and a non-event trigger stays immediate.',
            properties: {
              event_id: { type: 'string', description: 'Event id, e.g. "SAP_TEST".' },
              event_parameter: { type: 'string', description: 'Event parameter. Defaults to the chain name when omitted.' },
              event_type: { type: 'string', description: 'Event type. Defaults to "OtherEvent".' },
              only_once: { type: 'boolean', description: 'Start only once. Default false.' },
            },
            required: ['event_id'],
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the update. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'steps', 'edges'],
      },
    },
    {
      name: 'bw_activate_process_chain',
      description:
        'Activate an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Use this after bw_create_process_chain (with activate=false) or to re-activate a modified chain. ' +
        'Returns the top-level activation message, severity, and full log entries. ' +
        'Surfaces any log entries with severity "error" in a dedicated errors field.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_decision_variant',
      description:
        'Create a DECISION process variant (a standalone TLOGO object) for use as a branch/decision step in a Process Chain, via the BW/4HANA Cockpit REST API. ' +
        'The variant holds two branches indexed by position: THEN/first (EVENTNO "01" by default, label "JA") and ELSE/second (EVENTNO "02", label "NEIN"). ' +
        'The formula is the branch condition (e.g. "GET_SEGMENT( ) = \' 3\'"); it is evaluated for the THEN branch, the ELSE branch is its complement. ' +
        'The variant is created AND activated (activation is mandatory — an inactive variant is not selectable in the chain variant picker). ' +
        'After creation, reference the variant from a DECISION step in bw_create_process_chain / bw_update_process_chain (variant=<this name>), and branch its out-edges with sub_status "01"/"02". ' +
        'Package/transport: $TMP is fine for visibility and picker selection; pass a transportable package (NOT $TMP) only if you need to transport the variant. ' +
        'For a transportable package a transport_request is used (auto-selected when exactly one changeable request is available; pass it to disambiguate).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Decision variant technical name, uppercase (e.g. "VARIANT_NAME"). This is the name a chain DECISION step references.',
          },
          description: {
            type: 'string',
            description: 'Variant description / label.',
          },
          formula: {
            type: 'string',
            description: 'Branch condition formula (BW decision formula syntax), e.g. "GET_SEGMENT( ) = \' 3\'".',
          },
          package: {
            type: 'string',
            description: 'Target package. Defaults to $TMP, which is fine for visibility/picker selection. Pass a transportable package only if the variant must be transportable.',
          },
          transport_request: {
            type: 'string',
            description: 'Transport request to record the new variant into. Used only for a transportable package (auto-selected when exactly one changeable request is available; pass to disambiguate).',
          },
          then_label: {
            type: 'string',
            description: 'Label of the THEN/first branch. Default "JA".',
          },
          else_label: {
            type: 'string',
            description: 'Label of the ELSE/second branch. Default "NEIN".',
          },
          then_event_no: {
            type: 'string',
            description: 'EVENTNO of the THEN branch (referenced by chain branch edges via sub_status). Default "01".',
          },
          else_event_no: {
            type: 'string',
            description: 'EVENTNO of the ELSE branch. Default "02".',
          },
        },
        required: ['name', 'description', 'formula'],
      },
    },
    {
      name: 'bw_add_process_chain_error_links',
      description:
        'Add on-error (negative) links to an existing Process Chain (RSPC) by mirroring the existing ' +
        'on-success (positive) out-edges of its DTP load steps, via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, appends the negative edges (skipping any that already exist), and PUTs it back. ' +
        'Optionally activates afterwards. ' +
        'Use dtps to restrict to specific steps; omit it to apply to every DTP load step. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          dtps: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional. Restrict to these steps. Each entry is matched against a step\'s DTP name (exact) ' +
              'or as a substring of its step description (which contains the target object name). ' +
              'Omit to apply to all DTP load steps.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_swap_process_chain_dtp',
      description:
        'Swap one DTP load variant for another in an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, replaces the matching DTP_LOAD node\'s variant, and PUTs it back — ' +
        'edges and all other nodes are preserved unchanged. Prefer this over bw_update_process_chain for a single-variant swap, ' +
        'since it does not require re-specifying the whole chain. ' +
        'Optionally activates afterwards. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          old_dtp: {
            type: 'string',
            description: 'DTP variant name currently in the chain (e.g. "DTP_NAME_OLD").',
          },
          new_dtp: {
            type: 'string',
            description: 'DTP variant name to set instead (e.g. "DTP_NAME_NEW").',
          },
          refresh_description: {
            type: 'boolean',
            description: 'If true (default), pull the new variant\'s step description from its metadata. Cosmetic; the existing description is kept if metadata is unavailable.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'old_dtp', 'new_dtp'],
      },
    },
    {
      name: 'bw_append_process_chain_dtp',
      description:
        'Add one DTP load step (optionally followed by its own DSO activation step) to an existing Process Chain (RSPC), ' +
        'via the BW/4HANA Cockpit REST API. In-place edit: reads the current model, inserts the node(s)/edge(s)/inline variant, ' +
        'and PUTs it back — the caller does not supply the full model. ' +
        'Positioning: pass "before" to place the block IN SERIES ahead of an existing step (the target\'s incoming edges are rerouted into the block, then the block links to the target), or "after" to place it in series between a step and its successors. ' +
        'With neither, the block is only APPENDED behind the strand end closest to the trigger (or behind "predecessor") — the target keeps its existing successors, so the block ends up running in PARALLEL to them, not ahead of them. Use before/after whenever the new step must complete before an existing one starts. ' +
        'When adsoact is given, the whole DTP → activation block is placed as one unit. ' +
        'edge_mode defaults to "both", which adds an on-success AND an on-error edge per link ("always continue" — the successor runs even after a failed load). Pass "success_only" for an on-success edge only, which is what a chain whose existing DTP steps have no error edge expects. ' +
        'Idempotent: if the DTP is already a node in the chain, it is skipped without writing. ' +
        'Optionally activates afterwards and then verifies that no collector was inserted and no extra strand appeared. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          dtp: {
            type: 'string',
            description: 'DTP variant name to append (e.g. "DTP_NAME").',
          },
          adsoact: {
            type: 'string',
            description: 'Optional aDSO name (e.g. "ADSO_NAME"). When given, an ADSOACT step activating this aDSO is added right after the DTP (per-DTP activation) and the two form one block that is placed together.',
          },
          before: {
            type: 'string',
            description:
              'Insert the block IN SERIES BEFORE this node: the target\'s incoming edges are rerouted into the block, then the block links to the target. ' +
              'Node reference — see the note below. Mutually exclusive with "after".',
          },
          after: {
            type: 'string',
            description:
              'Insert the block IN SERIES AFTER this node — it runs between the target and its former successors. Mutually exclusive with "before".',
          },
          predecessor: {
            type: 'string',
            description:
              'Used only when neither before nor after is given. Node to APPEND behind, or the literal "strand_end_auto" (default = terminal node closest to the trigger, ties → first). ' +
              'An append leaves the target\'s existing successors untouched, so the new block runs in parallel to them — pass before/after instead when it must run in sequence. ' +
              'Node reference forms (same for before / after / predecessor): a DTP or process-variant name; an aDSO held by an ADSOACT/ADSOREM node; the program of an ABAP step, or "PROGRAM/VARIANT"; "TRIGGER" or a collector type ("AND"/"OR"); or "#<index>" using the step numbers printed by bw_get_process_chain. An ambiguous name is rejected with the candidates listed — use "#<index>" then.',
          },
          edge_mode: {
            type: 'string',
            enum: ['both', 'success_only'],
            description:
              '"both" (default): add an on-success AND an on-error edge per link, so the successor runs even after a failed load ("always continue"). ' +
              '"success_only": add only the on-success edge. Match whatever the chain\'s existing steps use — the default adds an error edge that a success-only chain does not have.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'dtp'],
      },
    },
    {
      name: 'bw_add_process_chain_program',
      description:
        'Add an "Execute ABAP Program" step (RSPC process type ABAP, "Programm ausführen") to an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'Runs an ABAP report, optionally with a named SE38 selection variant. ' +
        'In-place edit: reads the current model, inserts the node + its INLINE process variant (the program call is stored inline in the chain — there is no separate variant object), and PUTs it back. ' +
        'Positioning: pass "before" to run the program ahead of an existing step (the target\'s incoming edges are rerouted through the new step, e.g. Start → PROGRAM → DTP); pass "after" to run it between a step and its successors; pass neither (optionally with predecessor) to append behind the strand end closest to the trigger. ' +
        'edge_mode "both" (default) adds an on-success and an on-error edge per new link; "success_only" adds only the on-success edge. ' +
        'Idempotent: if an ABAP step already calls the same program (and variant), it is skipped without writing. ' +
        'Only the synchronous/local/program call configuration is verified; keep the defaults. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          program: {
            type: 'string',
            description: 'ABAP program / report to execute (e.g. "REPORT_NAME").',
          },
          variant: {
            type: 'string',
            description: 'Optional ABAP report (SE38) selection variant name (e.g. "VARIANT_NAME"). Omit to run the report without a variant.',
          },
          description: {
            type: 'string',
            description: 'Optional step description (cosmetic).',
          },
          before: {
            type: 'string',
            description:
              'Insert the program step BEFORE this node (its DTP/variant name, or an aDSO held by an ADSOACT node). ' +
              'The target\'s incoming edges are rerouted through the new step. Mutually exclusive with "after".',
          },
          after: {
            type: 'string',
            description:
              'Insert the program step AFTER this node — it runs between the target and its former successors. Mutually exclusive with "before".',
          },
          predecessor: {
            type: 'string',
            description:
              'Used only when neither before nor after is given. Node to append behind (a DTP/variant name, an aDSO held by an ADSOACT node) or the literal "strand_end_auto" (default = terminal node closest to the trigger).',
          },
          edge_mode: {
            type: 'string',
            enum: ['both', 'success_only'],
            description: '"both" (default): add an on-success and an on-error edge per new link. "success_only": add only the on-success edge.',
          },
          program_package: {
            type: 'string',
            description: 'Optional package of the report (cosmetic value-help enrichment; the server re-derives it when omitted).',
          },
          program_description: {
            type: 'string',
            description: 'Optional report description (cosmetic).',
          },
          variant_description: {
            type: 'string',
            description: 'Optional variant description (cosmetic).',
          },
          synchronous: {
            type: 'boolean',
            description: 'Call mode. true (default) runs the program synchronously (X_SYNCHRON). Only the default is verified.',
          },
          local: {
            type: 'boolean',
            description: 'Call location. true (default) runs the program on this system (X_LOCAL). Only the default is verified.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'program'],
      },
    },
    {
      name: 'bw_add_process_chain_edge',
      description:
        'Add one dependency (edge) between two existing steps of a Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, appends the edge, and PUTs it back. ' +
        'Use this to repair the wiring of a chain — for example to connect the end of a newly inserted block to the step that must run after it. ' +
        'Note that an "always continue" dependency is TWO edges (one on-success, one on-error): call this twice, once with status "positive" and once with "negative". ' +
        'Idempotent: an identical edge is skipped without writing. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          from: {
            type: 'string',
            description:
              'Source step. Node reference forms: a DTP or process-variant name; an aDSO held by an ADSOACT/ADSOREM node; the program of an ABAP step, or "PROGRAM/VARIANT"; ' +
              '"TRIGGER" or a collector type ("AND"/"OR"); or "#<index>" using the step numbers printed by bw_get_process_chain. An ambiguous name is rejected with the candidates listed.',
          },
          to: {
            type: 'string',
            description: 'Target step. Same reference forms as "from".',
          },
          status: {
            type: 'string',
            enum: ['neutral', 'positive', 'negative'],
            description:
              'Edge condition: "positive" = on success, "negative" = on error, "neutral" = unconditional. ' +
              'Defaults to "neutral" when the source is the TRIGGER or a collector (neither can succeed or fail), "positive" otherwise.',
          },
          sub_status: {
            type: 'string',
            description:
              'Branch condition for an edge leaving a DECISION step: the branch EVENTNO, e.g. "01" (THEN/JA) or "02" (ELSE/NEIN). ' +
              'Defaults to "00" (a normal, non-branch edge). A branch edge is always "positive".',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'from', 'to'],
      },
    },
    {
      name: 'bw_remove_process_chain_edge',
      description:
        'Remove the dependency (edge) between two existing steps of a Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, drops the matching edge(s), and PUTs it back. ' +
        'By default every edge between the two steps is removed, which is what an "always continue" dependency needs (it is stored as an on-success plus an on-error edge); pass status to remove just one of them. ' +
        'Use this together with bw_add_process_chain_edge to re-route a mis-wired chain. ' +
        'Removing an edge can leave a step unreachable from the start — the chain will not activate until every step has a path from the trigger. ' +
        'Reports a skip when no matching edge exists. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          from: {
            type: 'string',
            description:
              'Source step. Node reference forms: a DTP or process-variant name; an aDSO held by an ADSOACT/ADSOREM node; the program of an ABAP step, or "PROGRAM/VARIANT"; ' +
              '"TRIGGER" or a collector type ("AND"/"OR"); or "#<index>" using the step numbers printed by bw_get_process_chain.',
          },
          to: {
            type: 'string',
            description: 'Target step. Same reference forms as "from".',
          },
          status: {
            type: 'string',
            enum: ['neutral', 'positive', 'negative'],
            description: 'Remove only edges with this condition. Omit to remove every edge between the two steps.',
          },
          sub_status: {
            type: 'string',
            description: 'Remove only edges with this branch condition (a DECISION branch EVENTNO, e.g. "01"). Omit to ignore the branch condition.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'from', 'to'],
      },
    },
    {
      name: 'bw_remove_process_chain_step',
      description:
        'Remove one step (node) from a Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, drops the node together with every edge touching it and its inline process variant, and PUTs it back. ' +
        'By default the gap is bridged — every predecessor of the removed step takes over every successor, keeping the condition of the edge that ran into the removed step — so the strand stays connected. Pass reconnect=false to leave the successors disconnected. ' +
        'Use this to roll back a step that was inserted in the wrong place. ' +
        'The TRIGGER (Start) step cannot be removed. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          step: {
            type: 'string',
            description:
              'Step to remove. Node reference forms: a DTP or process-variant name; an aDSO held by an ADSOACT/ADSOREM node; the program of an ABAP step, or "PROGRAM/VARIANT"; ' +
              'a collector type ("AND"/"OR"); or "#<index>" using the step numbers printed by bw_get_process_chain. An ambiguous name is rejected with the candidates listed — use "#<index>" then.',
          },
          reconnect: {
            type: 'boolean',
            description:
              'true (default): bridge the gap so each predecessor of the removed step links to each of its successors. ' +
              'false: drop the edges without bridging, which leaves the successors as a strand nothing leads to (the chain then will not activate until they are re-wired with bw_add_process_chain_edge).',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'step'],
      },
    },
    {
      name: 'bw_create_transport_task',
      description:
        'Add a task (sub-request) for a user to an existing workbench transport request. ' +
        'Single ADT call, no lock or activation. The parent request must be modifiable. ' +
        'Returns the created task number.',
      inputSchema: {
        type: 'object',
        properties: {
          transport_request: {
            type: 'string',
            description: 'Parent workbench transport request number (e.g. DEVK900123).',
          },
          user: {
            type: 'string',
            description: 'Target user the task is created for (task owner), e.g. "USERNAME".',
          },
        },
        required: ['transport_request', 'user'],
      },
    },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleToolCall(
  request: { params: { name: string; arguments?: Record<string, unknown> } },
  extra: { authInfo?: AuthInfo },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { name, arguments: args } = request.params;

  // Deny before doing any work. stdio has no authInfo and nothing to check.
  if (!hasScope(extra.authInfo, requiredScope(name))) {
    throw new McpError(ErrorCode.InvalidRequest, `Tool '${name}' requires the '${requiredScope(name)}' scope.`);
  }

  // HTTP: the per-request client, whose identity came from XSUAA and the destination.
  // stdio: no request context, so read the environment exactly as before.
  const client = currentClient() ?? createClientFromEnv();

  try {
    await ensureMediaTypes(client);
    let text: string;

    switch (name) {
      case 'bw_search':
        text = await bwSearch(
          client,
          args?.search_term as string,
          args?.object_type as string | undefined
        );
        break;

      case 'bw_xref':
        text = await bwXref(
          client,
          args?.object_type as string,
          args?.object_name as string,
          args?.source_system as string | undefined,
        );
        break;

      case 'bw_get_adso':
        text = await bwGetAdso(
          client,
          args?.adso_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_create_adso':
        text = await bwCreateAdso(
          client,
          args?.adso_name as string,
          args?.label as string,
          args?.info_area as string,
          (args?.action as 'from_template' | 'empty') ?? 'from_template',
          args?.template_name as string | undefined,
          (args?.template_type as 'ADSO' | 'RSDS') ?? 'ADSO',
          args?.source_system as string | undefined,
          (args?.adso_type as string) ?? 'standard',
          (args?.package as string) ?? '$TMP',
          (args?.write_interface as boolean) ?? false
        );
        break;

      case 'bw_update_adso':
        if (args?.action === 'update_settings') {
          const s = (args?.settings ?? {}) as Record<string, unknown>;
          const settings: AdsoSettings = {
            adsoType: s['adso_type'] as AdsoSettings['adsoType'],
            writeChangelog: s['write_changelog'] as boolean | undefined,
            snapShotScenario: s['snap_shot_scenario'] as boolean | undefined,
            uniqueDataRecords: s['unique_data_records'] as boolean | undefined,
            planningMode: s['planning_mode'] as boolean | undefined,
            writeInterface: s['write_interface'] as boolean | undefined,
            label: s['label'] as string | undefined,
          };
          // Remove undefined keys so applied output is clean
          (Object.keys(settings) as Array<keyof AdsoSettings>).forEach(
            (k) => settings[k] === undefined && delete settings[k]
          );
          settings.transport = args?.transport as string | undefined;
          text = await bwUpdateAdsoSettings(client, args?.adso_name as string, settings);
        } else if (args?.action === 'manage_keys') {
          text = await bwUpdateAdsoManageKeys(
            client,
            args?.adso_name as string,
            (args?.key_fields as string[]) ?? [],
            args?.transport as string | undefined
          );
        } else if (args?.action === 'add_pure_field') {
          const rawFields = (args?.fields as Array<Record<string, unknown>>) ?? [];
          const fieldDefs: FieldDef[] = rawFields.map((f) => ({
            name: f['name'] as string,
            label: f['label'] as string,
            dataType: f['data_type'] as string,
            length: f['length'] as number | undefined,
            precision: f['precision'] as number | undefined,
            scale: f['scale'] as number | undefined,
            aggregationBehavior: f['aggregation_behavior'] as string | undefined,
            isKey: f['is_key'] as boolean | undefined,
            dimension: f['dimension'] as string | undefined,
          }));
          text = await bwUpdateAdsoAddPureField(client, args?.adso_name as string, fieldDefs, args?.transport as string | undefined);
        } else if (args?.action === 'update_field_properties') {
          const p = (args?.properties ?? {}) as Record<string, unknown>;
          const fp: FieldProperties = {};
          if (p['sid_determination_mode'] !== undefined) fp.sidDeterminationMode = p['sid_determination_mode'] as FieldProperties['sidDeterminationMode'];
          if ('local_description' in p) fp.localDescription = p['local_description'] as string | null;
          if (p['aggregation_behavior'] !== undefined) fp.aggregationBehavior = p['aggregation_behavior'] as FieldProperties['aggregationBehavior'];
          if ('fixed_currency' in p) fp.fixedCurrency = p['fixed_currency'] as string | null;
          if ('fixed_unit' in p) fp.fixedUnit = p['fixed_unit'] as string | null;
          if ('unit_currency_field' in p) fp.unitCurrencyField = p['unit_currency_field'] as string | null;
          if (p['description'] !== undefined) fp.description = p['description'] as string;
          if (p['dimension'] !== undefined) fp.dimension = p['dimension'] as string;
          fp.transport = args?.transport as string | undefined;
          text = await bwUpdateAdsoFieldProperties(
            client,
            args?.adso_name as string,
            args?.field_name as string,
            fp
          );
        } else {
          text = await bwUpdateAdso(
            client,
            args?.adso_name as string,
            args?.infoobject_name as string,
            (args?.action as 'add_field' | 'remove_field') ?? 'add_field',
            args?.transport as string | undefined,
            args?.dimension as string | undefined
          );
        }
        break;

      case 'bw_create_infoobject':
        text = await bwCreateInfoObject(client, {
          infoobject_type: args?.infoobject_type as 'CHA' | 'KYF' | undefined,
          name: args?.name as string,
          info_area: args?.info_area as string,
          description: args?.description as string,
          data_type: args?.data_type as string | undefined,
          length: args?.length as number | undefined,
          conversion_routine: args?.conversion_routine as string | undefined,
          with_master_data: args?.with_master_data as boolean | undefined,
          with_texts: args?.with_texts as boolean | undefined,
          referenced_infoobject: args?.referenced_infoobject as string | undefined,
          compound_infoobjects: args?.compound_infoobjects as string[] | undefined,
          object_specific_data_type: args?.object_specific_data_type as string | undefined,
          aggregation_type: args?.aggregation_type as string | undefined,
          fixed_unit: args?.fixed_unit as string | undefined,
          fixed_currency: args?.fixed_currency as string | undefined,
          package: args?.package as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_create_infoarea':
        text = await bwCreateInfoArea(client, {
          name: args?.name as string,
          parent_info_area: args?.parent_info_area as string | undefined,
          description: args?.description as string | undefined,
          package: args?.package as string | undefined,
        });
        break;

      case 'bw_create_transformation':
        text = await bwCreateTransformation(client, {
          source_object_type: args?.source_object_type as string,
          source_object_name: args?.source_object_name as string,
          target_object_type: args?.target_object_type as string,
          target_object_name: args?.target_object_name as string,
          package: args?.package as string | undefined,
          source_system: args?.source_system as string | undefined,
          copy_from_transformation: args?.copy_from_transformation as string | undefined,
          source_object_subtype: args?.source_object_subtype as string | undefined,
          target_object_subtype: args?.target_object_subtype as string | undefined,
        });
        break;

      case 'bw_move_object':
        text = await bwMoveObject(client, {
          objectType: args?.object_type as string,
          objectName: args?.object_name as string,
          targetInfoArea: args?.target_info_area as string,
        });
        break;

      case 'bw_change_package':
        text = await bwChangePackage(client, {
          objectName: args?.object_name as string,
          objectType: args?.object_type as string,
          package: args?.package as string,
          transport: args?.transport as string | undefined,
          sourceSystem: args?.source_system as string | undefined,
        });
        break;

      case 'bw_list_changeable_transports':
        text = await bwListChangeableTransports(client, {
          ownOnly: args?.own_only as boolean ?? true,
          modifiableOnly: args?.modifiable_only as boolean ?? true,
          includeObjects: args?.include_objects as boolean ?? false,
        });
        break;

      case 'bw_get_infoobject':
        text = await bwGetInfoObject(client, args?.infoobject_name as string);
        break;

      case 'bw_update_infoobject': {
        const rawAttrs = (args?.attributes as Array<Record<string, unknown>> | undefined) ?? [];
        const attrDefs: AttributeDef[] = rawAttrs.map((a) => ({
          name: a['name'] as string,
          type: a['type'] as 'DIS' | 'NAV',
          timeDependent: a['time_dependent'] as boolean | undefined,
          displayInQuery: a['display_in_query'] as boolean | undefined,
          useTextOfOriginalCharacteristic: a['use_text_of_original_characteristic'] as boolean | undefined,
        }));
        text = await bwUpdateInfoObject(client, {
          name: args?.name as string,
          attributes: attrDefs,
          description: args?.description as string | undefined,
          fixed_unit: args?.fixed_unit as string | undefined,
          fixed_currency: args?.fixed_currency as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;
      }

      case 'bw_get_transformation':
        text = await bwGetTransformation(
          client,
          args?.transformation_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_update_transformation':
        text = await bwUpdateTransformation(
          client,
          args?.transformation_name as string,
          args?.source_field as string | undefined,
          args?.target_infoobject as string,
          (args?.rule_type as 'direct' | 'routine' | 'formula' | 'constant' | 'lookup' | 'no_update' | undefined) ?? 'direct',
          args?.formula as string | undefined,
          args?.constant_value as string | undefined,
          args?.lookup_object as string | undefined,
          args?.lookup_object_type as string | undefined,
          args?.transport as string | undefined,
          args?.additional_source_fields as string[] | undefined,
          args?.unit_source_field as string | undefined,
        );
        break;

      case 'bw_delete_transformation_routine':
        text = await bwDeleteTransformationRoutine(
          client,
          args?.transformation_name as string,
          args?.routine_type as 'start' | 'end' | 'expert'
        );
        break;

      case 'bw_set_transformation_routine':
        text = await bwSetTransformationRoutine(
          client,
          args?.transformation_name as string,
          args?.routine_type as 'start' | 'end' | 'expert',
          args?.transport as string | undefined
        );
        break;

      case 'bw_set_transformation_expert_routine':
        text = await bwSetTransformationExpertRoutine(
          client,
          args?.transformation_name as string,
          args?.source as string | undefined,
          (args?.routine_type as 'start' | 'end' | 'expert' | undefined) ?? 'expert',
          args?.transport as string | undefined,
          args?.class_name as string | undefined,
          args?.method_name as string | undefined,
        );
        break;

      case 'bw_set_transformation_routine_fields':
        text = await bwSetTransformationRoutineFields(
          client,
          args?.transformation_name as string,
          args?.fields as string[] | undefined,
          args?.exclude_fields as string[] | undefined,
          args?.transport as string | undefined
        );
        break;

      case 'bw_set_transformation_runtime':
        text = await bwSetTransformationRuntime(
          client,
          args?.transformation_name as string,
          args?.runtime as 'hana' | 'abap',
          args?.transport as string | undefined
        );
        break;

      case 'bw_activate':
        text = await bwActivate(
          client,
          args?.object_type as string,
          args?.object_name as string,
          args?.lock_handle as string,
          args?.transport as string | undefined,
          args?.source_system as string | undefined
        );
        break;

      case 'bw_delete':
        text = await bwDelete(
          client,
          args?.object_type as string,
          args?.object_name as string
        );
        break;

      case 'bw_unlock': {
        const unlockType = (args?.object_type as string) ?? '';
        const unlockName = args?.object_name as string;
        // DTPs use the DTP-framework enqueue (RSBKDTP); client.unlock treats dtpa as
        // no-op, so route it to the explicit action=unlock endpoint.
        if (unlockType.toLowerCase() === 'dtpa') {
          await bwUnlockDtp(client, unlockName);
        } else {
          await client.unlock(unlockType, unlockName);
        }
        text = JSON.stringify({ success: true, message: `Lock on ${unlockType.toUpperCase()} '${unlockName}' released.` });
        break;
      }

      case 'bw_get_infosource':
        text = await bwGetInfosource(client, args?.name as string);
        break;

      case 'bw_get_infoarea':
        text = await bwGetInfoarea(client, args?.name as string);
        break;

      case 'bw_create_infosource':
        text = await bwCreateInfosource(
          client,
          args?.name as string,
          args?.description as string,
          args?.info_area as string,
          (args?.package as string) ?? '$TMP',
          args?.copy_from_object_name as string | undefined,
          args?.copy_from_object_type as string | undefined,
          args?.copy_from_object_sub_type as string | undefined,
          args?.copy_from_source_system as string | undefined
        );
        break;

      case 'bw_update_infosource': {
        const rawFields = args?.fields as Array<Record<string, unknown>> | undefined;
        const fieldDefs: InfosourceField[] | undefined = rawFields?.map((f) => ({
          name: f['name'] as string,
          infoObjectName: f['infoobject_name'] as string | undefined,
          type: f['type'] as string,
          length: f['length'] as number,
          label: f['label'] as string,
          isKey: f['is_key'] as boolean | undefined,
          aggregationBehavior: f['aggregation_behavior'] as string | undefined,
        }));
        text = await bwUpdateInfosource(
          client,
          args?.name as string,
          args?.description as string | undefined,
          fieldDefs,
          args?.transport as string | undefined,
          args?.remove_fields as string[] | undefined
        );
        break;
      }

      case 'bw_get_dtps':
        text = await bwGetDtps(
          client,
          args?.object_type as string,
          args?.object_name as string
        );
        break;

      case 'bw_get_dtp':
        text = await bwGetDtp(client, args?.dtp_name as string);
        break;

      case 'bw_get_process_chain':
        text = await bwGetProcessChain(
          client,
          args?.chain_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
          args?.include_variant_details !== false,
        );
        break;

      case 'bw_get_process_variant':
        text = await bwGetProcessVariant(
          client,
          args?.process_type as string,
          args?.variant_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_list_requests':
        text = await bwListRequests(
          client,
          args?.target as string,
          args?.target_type as string | undefined ?? 'ADSO',
          args?.storage as string | undefined ?? 'AQ,AX,AT',
          args?.status as string | undefined ?? 'N,GG,GR,YG,RR,YR,RG,U,Y,X',
          args?.top as number | undefined ?? 3,
          args?.created_from as string | undefined,
        );
        break;

      case 'bw_get_request':
        text = await bwGetRequest(
          client,
          args?.request_tsn as string,
          args?.storage as string | undefined ?? 'AQ',
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_activate_request':
        text = await bwActivateRequest(
          args?.request_tsn as string,
          args?.storage as string | undefined ?? 'AQ',
        );
        break;

      case 'bw_list_remodeling_requests':
        text = await bwListRemodelingRequests(
          client,
          args?.info_provider as string | undefined,
          args?.status as string | undefined,
          args?.top as number | undefined ?? 20,
        );
        break;

      case 'bw_get_remodeling_request':
        text = await bwGetRemodelingRequest(
          client,
          args?.info_provider as string,
          args?.remodeling_rule as string,
          args?.request_number as string | undefined,
          args?.include_log as boolean | undefined ?? true,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_run_remodeling':
        text = await bwRunRemodeling(
          client,
          args?.action as RemodelingAction | undefined ?? 'execute',
          args?.info_provider as string,
          args?.remodeling_rule as string,
          args?.request_number as string | undefined,
          args?.start as string | undefined ?? 'immediate',
        );
        break;

      case 'bw_create_dtp':
        text = await bwCreateDtp(client, {
          trfn_name: args?.trfn_name as string,
          trfn_name_2: args?.trfn_name_2 as string | undefined,
          source_name: args?.source_name as string,
          source_type: args?.source_type as string,
          source_system: args?.source_system as string | undefined,
          target_name: args?.target_name as string,
          target_type: args?.target_type as string,
          target_object_subtype: args?.target_object_subtype as string | undefined,
          description: args?.description as string | undefined,
          package: args?.package as string | undefined,
          filter_field: args?.filter_field as string | undefined,
          filter_value: args?.filter_value as string | undefined,
          filter_excluding: args?.filter_excluding as boolean | undefined,
          filter_selections: args?.filter_selections as DtpFilterSelectionInput[] | undefined,
        });
        break;

      case 'bw_run_dtp':
        text = await bwRunDtp(args?.dtp_name as string);
        break;

      case 'bw_set_dtp_filter_routine':
        text = await bwSetDtpFilterRoutine(client, {
          dtp_name: args?.dtp_name as string,
          field_name: args?.field_name as string,
          routine_code: args?.routine_code as string,
          global_code: args?.global_code as string | undefined,
        });
        break;

      case 'bw_update_dtp':
        text = await bwUpdateDtp(client, {
          dtp_name: args?.dtp_name as string,
          description: args?.description as string | undefined,
          filter_field: args?.filter_field as string | undefined,
          filter_value: args?.filter_value as string | undefined,
          filter_excluding: args?.filter_excluding as boolean | undefined,
          filter_selections: args?.filter_selections as DtpFilterSelectionInput[] | undefined,
          filter_clear_fields: args?.filter_clear_fields as string | undefined,
          extraction_mode: args?.extraction_mode as 'full' | 'delta' | undefined,
          semantic_group_fields: args?.semantic_group_fields as string | undefined,
          transport: args?.transport as string | undefined,
          transport_lock_holder: args?.transport_lock_holder as string | undefined,
        });
        break;

      case 'bw_get_push_schema':
        text = await bwGetPushSchema(args?.adso_name as string);
        break;

      case 'bw_push_data':
        text = await bwPushData(
          args?.adso_name as string,
          args?.records as object[],
          (args?.mode as string) ?? 'one_step'
        );
        break;

      case 'bw_get_query':
        text = await bwGetQuery(
          args?.query_name as string,
          (args?.format as 'text' | 'raw') ?? 'text'
        );
        break;

      case 'bw_create_query':
        text = await bwCreateQuery(client, {
          query_name: args?.query_name as string,
          infoprovider: args?.infoprovider as string | undefined,
          description: args?.description as string | undefined,
          copy_from: args?.copy_from as string | undefined,
        });
        break;

      case 'bw_create_variable':
        text = await bwCreateVariable(client, {
          variable_name: args?.variable_name as string,
          iobj_name: args?.iobj_name as string,
          description: args?.description as string,
          development_class: args?.development_class as string | undefined,
          ready_for_input: args?.ready_for_input as boolean | undefined,
          reusable: args?.reusable as boolean | undefined,
          represents: args?.represents as 'Interval' | 'SingleValue' | 'SeveralSingleValues' | 'SelectionOption' | undefined,
          processing_type: args?.processing_type as 'UserEntry' | 'CustomerExit' | 'Authorization' | 'ReplacementPath' | undefined,
          variable_type: args?.variable_type as 'CharacteristicValue' | 'Hierarchy' | 'HierarchyNodes' | undefined,
          input_type: args?.input_type as 'Optional' | 'MandatoryWithInitial' | 'MandatoryWithoutInitial' | undefined,
          master_language: args?.master_language as string | undefined,
          package: args?.package as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_update_query_layout':
        text = await bwUpdateQueryLayout(client, {
          query_name: args?.query_name as string,
          operations: args?.operations as LayoutOperation[],
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_update_query_filter':
        text = await bwUpdateQueryFilter(client, {
          query_name: args?.query_name as string,
          operations: args?.operations as FilterOperation[],
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_update_query_key_figures':
        text = await bwUpdateQueryKeyFigures(client, {
          query_name: args?.query_name as string,
          structure_target: args?.structure_target as 'rows' | 'columns' | undefined,
          operations: args?.operations as KeyFigureOperation[],
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_update_query_settings':
        text = await bwUpdateQuerySettings(client, args as unknown as UpdateQuerySettingsArgs);
        break;

      case 'bw_update_query_characteristic':
        text = await bwUpdateQueryCharacteristic(client, args as unknown as UpdateQueryCharacteristicArgs);
        break;

      case 'bw_list_contents':
        text = await bwListContents(client, args?.path as string);
        break;

      case 'bw_read_metadata_tables':
        text = await bwReadMetadataTables(
          client,
          args?.object_type as string,
          args?.object_name as string,
        );
        break;

      case 'bw_system_profile':
        text = await bwSystemProfile(client);
        break;

      case 'bw_list_source_systems':
        text = await bwListSourceSystems(client, args?.source_system_type as string | undefined);
        break;

      case 'bw_list_datasources':
        text = await bwListDatasources(
          client,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
          args?.apco_path_filter as string | undefined,
        );
        break;

      case 'bw_get_source_system':
        text = await bwGetSourceSystem(client, args?.source_system as string);
        break;

      case 'bw_get_datasource':
        text = await bwGetDatasource(
          client,
          args?.datasource_name as string,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_change_datasource_delta':
        text = await bwChangeDatasourceDelta(client, {
          datasourceName: args?.datasource_name as string,
          sourceSystem: args?.source_system as string,
          deltaProcess: args?.delta_process as string,
        });
        break;

      case 'bw_set_datasource_fields':
        text = await bwSetDatasourceFields(client, {
          datasourceName: args?.datasource_name as string,
          sourceSystem: args?.source_system as string,
          fields: args?.fields as Array<{ name: string; transfer: boolean }> | undefined,
          languageField: args?.language_field as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_preview_datasource':
        text = await bwPreviewDatasource(
          client,
          args?.datasource_name as string,
          args?.source_system as string,
          (args?.records as number | undefined) ?? 20,
        );
        break;

      case 'bw_list_remote_entities':
        text = await bwListRemoteEntities(
          client,
          args?.source_system as string,
          (args?.search_pattern as string | undefined) ?? '*',
          (args?.result_size as number | undefined) ?? 200,
        );
        break;

      case 'bw_create_datasource':
        text = await bwCreateDatasource(
          client,
          args?.datasource_name as string,
          args?.source_system as string,
          args?.application_component as string,
          args?.hana_entity as string | undefined,
          args?.description as string | undefined,
        );
        break;

      case 'bw_get_composite_provider':
        text = await bwGetCompositeProvider(client, args?.composite_provider_name as string);
        break;

      case 'bw_update_composite_provider': {
        const cpName = args?.composite_provider_name as string;
        const cpAction = (args?.action as string | undefined) ?? 'add_field';
        const cpTransport = args?.transport as string | undefined;
        const cpMappings = ((args?.mappings as Array<Record<string, string>> | undefined) ?? []).map((m) => ({
          target: m.target,
          source: m.source,
          constantValue: m.constant_value,
          infoObjectName: m.info_object_name,
        }));

        switch (cpAction) {
          case 'add_field':
          case 'remove_field':
            text = await bwUpdateCompositeProvider(
              client,
              cpName,
              args?.info_object_name as string,
              cpAction as CompositeProviderFieldAction,
              args?.source_providers as string | undefined,
              cpTransport,
            );
            break;
          case 'add_input':
            text = await bwUpdateCompositeProviderInput(client, cpName, 'add_input', {
              input: {
                providerName: args?.provider_name as string,
                providerType: (args?.provider_type as string | undefined) ?? 'ADSO',
                mappings: cpMappings,
              },
              transport: cpTransport,
            });
            break;
          case 'remove_input':
            text = await bwUpdateCompositeProviderInput(client, cpName, 'remove_input', {
              inputAlias: args?.input_alias as string,
              transport: cpTransport,
            });
            break;
          case 'update_mapping':
            text = await bwUpdateCompositeProviderMapping(
              client,
              cpName,
              args?.input_alias as string,
              cpMappings,
              cpTransport,
            );
            break;
          case 'update_join':
            text = await bwUpdateCompositeProviderJoin(
              client,
              cpName,
              args?.left_alias as string,
              args?.right_alias as string,
              (args?.key_pairs as Array<{ left: string; right: string }> | undefined) ?? [],
              {
                joinType: args?.join_type as string | undefined,
                cardinality: args?.cardinality as string | undefined,
                transport: cpTransport,
              },
            );
            break;
          case 'remove_join':
            text = await bwRemoveCompositeProviderJoin(
              client,
              cpName,
              args?.left_alias as string,
              args?.right_alias as string,
              cpTransport,
            );
            break;
          case 'update_settings':
            text = await bwUpdateCompositeProviderSettings(client, cpName, {
              label: args?.label as string | undefined,
              stackable: args?.stackable as boolean | undefined,
              defaultNode: args?.default_node as string | undefined,
              aggregationBehaviour: args?.aggregation_behaviour as string | undefined,
              transport: cpTransport,
            });
            break;
          default:
            throw new Error(`Unknown action '${cpAction}' for bw_update_composite_provider.`);
        }
        break;
      }

      case 'bw_create_composite_provider':
        text = await bwCreateCompositeProvider(client, args?.composite_provider_name as string, {
          label: args?.label as string,
          infoArea: args?.info_area as string,
          viewType: args?.view_type as 'Join' | 'Union' | undefined,
          package: args?.package as string | undefined,
          stackable: args?.stackable as boolean | undefined,
          copyFrom: args?.copy_from as string | undefined,
          inputs: ((args?.inputs as Array<Record<string, string>> | undefined) ?? []).map((i) => ({
            providerName: i.provider_name,
            providerType: i.provider_type ?? 'ADSO',
          })),
        });
        break;

      case 'bw_get_ckf':
        text = await bwGetCkf(client, args?.component_name as string);
        break;

      case 'bw_get_rkf':
        text = await bwGetRkf(client, args?.component_name as string);
        break;

      case 'bw_get_structure':
        text = await bwGetStructure(client, args?.component_name as string);
        break;

      case 'bw_create_rkf':
        text = await bwCreateRkf(client, args as unknown as CreateRkfArgs);
        break;

      case 'bw_query_data': {
        const rawState = args?.state as { infoObjects: Array<Record<string, unknown>> } | undefined;
        const state = rawState
          ? {
              infoObjects: rawState.infoObjects.map((io): InfoObjectState => ({
                name: io['name'] as string,
                id: io['id'] as string,
                axis: io['axis'] as string,
                hierarchy: io['hierarchy'] as InfoObjectState['hierarchy'],
                filterValues: io['filterValues'] as InfoObjectState['filterValues'],
              })),
            }
          : undefined;
        const rawVars = args?.variables as Array<Record<string, unknown>> | undefined;
        const variables = rawVars?.map((v): VariableInput => ({
          name: v['name'] as string,
          id: v['id'] as string,
          txt: v['txt'] as string | undefined,
          altName: v['altName'] as string | undefined,
          type: v['type'] as string | undefined,
          inputEnabled: v['inputEnabled'] as boolean | undefined,
          mandatory: v['mandatory'] as boolean | undefined,
          iobj: v['iobj'] as string | undefined,
          values: v['values'] as VariableInput['values'],
        }));
        const rawDrillOps = args?.drill_operations as Array<Record<string, unknown>> | undefined;
        const drillOperations = rawDrillOps?.map((op): DrillOperation => ({
          axis: op['axis'] as 'ROWS' | 'COLUMNS',
          drill_state: op['drill_state'] as 3 | 2,
          tuple_idx: op['tuple_idx'] as number,
          element_idx: op['element_idx'] as number,
        }));
        text = await bwQueryData(
          client,
          args?.comp_id as string,
          (args?.is_provider as boolean) ?? false,
          (args?.format as 'text' | 'raw') ?? 'text',
          state,
          variables,
          (args?.from_row as number) ?? 0,
          (args?.to_row as number) ?? 1000,
          drillOperations
        );
        break;
      }

      case 'bw_get_filter_values':
        text = await bwGetFilterValues(
          client,
          args?.characteristic_name as string,
          args?.search_string as string,
          args?.info_provider as string | undefined,
          (args?.max_rows as number) ?? 201
        );
        break;

      case 'bw_get_roles':
        text = await bwGetRoles(
          client,
          args?.role_filter as string | undefined
        );
        break;

      case 'bw_get_query_roles':
        text = await bwGetQueryRoles(
          client,
          args?.query_name as string
        );
        break;

      case 'bw_set_query_roles':
        text = await bwSetQueryRoles(
          client,
          args?.query_name as string,
          args?.action as 'add' | 'remove',
          args?.target_name as string,
          args?.target_type as 'role' | 'folder',
          args?.parent_role_name as string | undefined
        );
        break;

      case 'bw_get_role_queries':
        text = await bwGetRoleQueries(
          client,
          args?.role_name as string | undefined
        );
        break;

      case 'bw_get_dataflow':
        text = await bwGetDataflow(
          client,
          args?.object_name as string,
          args?.object_type as string,
          args?.source_system as string | undefined,
          (args?.direction as 'upwards' | 'downwards' | 'both') ?? 'both',
          (args?.levels as number) ?? -1,
          (args?.format as 'text' | 'raw') ?? 'text',
        );
        break;

      case 'bw_get_open_hub':
        text = await bwGetOpenHub(client, args?.open_hub_name as string);
        break;

      case 'bw_create_aggregation_level':
        text = await bwCreateAggregationLevel(client, args?.aggregation_level_name as string, {
          label: args?.label as string,
          infoArea: args?.info_area as string,
          infoProvider: args?.info_provider as string,
          fields: args?.fields as string[] | undefined,
          package: args?.package as string | undefined,
          transport: args?.transport as string | undefined,
        });
        break;

      case 'bw_update_aggregation_level':
        text = await bwUpdateAggregationLevelFields(
          client,
          args?.aggregation_level_name as string,
          (args?.action as AggregationLevelFieldAction) ?? 'add_fields',
          args?.fields as string[],
          { transport: args?.transport as string | undefined }
        );
        break;

      case 'bw_get_aggregation_level':
        text = await bwGetAggregationLevel(client, args?.aggregation_level_name as string);
        break;

      case 'bw_get_planning_function':
        text = await bwGetPlanningFunction(client, args?.planning_function_name as string);
        break;

      case 'bw_get_planning_sequence':
        text = await bwGetPlanningSequence(client, args?.planning_sequence_name as string);
        break;

      case 'bw_get_planning_properties':
        text = await bwGetPlanningProperties(client, args?.plan_provider_name as string);
        break;

      case 'bw_list_process_chain_runs':
        text = await bwListProcessChainRuns(
          client,
          args?.chain_name as string | undefined,
          args?.date_from as string | undefined,
          args?.date_to as string | undefined,
          args?.status as string | undefined,
          (args?.limit as number | undefined) ?? 20,
        );
        break;

      case 'bw_get_process_chain_run_detail':
        text = await bwGetProcessChainRunDetail(
          client,
          args?.chain_id as string,
          args?.log_id as string,
        );
        break;

      case 'bw_list_process_chain_last_status':
        text = await bwListProcessChainLastStatus(
          client,
          args?.status as string | undefined,
          args?.last_start_from as string | undefined,
          args?.last_start_to as string | undefined,
          args?.limit as number | undefined,
        );
        break;

      case 'bw_create_process_chain': {
        const rawSteps = (args?.steps as Array<Record<string, unknown>>) ?? [];
        const steps = rawSteps.map(mapChainStep);
        const rawEdges = (args?.edges as Array<Record<string, unknown>>) ?? [];
        const edges: EdgeDef[] = rawEdges.map((e) => ({
          from: e['from'] as string,
          to: e['to'] as string,
          status: e['status'] as 'neutral' | 'positive' | 'negative' | undefined,
          subStatus: e['sub_status'] as string | undefined,
        }));
        text = await bwCreateProcessChain(client, {
          name: args?.name as string,
          infoarea: args?.infoarea as string,
          description: args?.description as string,
          steps: steps as unknown as CreateProcessChainParams['steps'],
          edges,
          activate: (args?.activate as boolean) ?? false,
          triggerEvent: mapTriggerEvent(args?.trigger_event),
        });
        break;
      }

      case 'bw_update_process_chain': {
        const rawSteps2 = (args?.steps as Array<Record<string, unknown>>) ?? [];
        const steps2 = rawSteps2.map(mapChainStep);
        const rawEdges2 = (args?.edges as Array<Record<string, unknown>>) ?? [];
        const edges2: EdgeDef[] = rawEdges2.map((e) => ({
          from: e['from'] as string,
          to: e['to'] as string,
          status: e['status'] as 'neutral' | 'positive' | 'negative' | undefined,
          subStatus: e['sub_status'] as string | undefined,
        }));
        text = await bwUpdateProcessChain(client, {
          name: args?.name as string,
          description: args?.description as string | undefined,
          infoarea: args?.infoarea as string | undefined,
          steps: steps2 as unknown as UpdateProcessChainParams['steps'],
          edges: edges2,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
          triggerEvent: mapTriggerEvent(args?.trigger_event),
        });
        break;
      }

      case 'bw_create_decision_variant':
        text = await bwCreateDecisionVariant(client, {
          name: args?.name as string,
          description: args?.description as string,
          formula: args?.formula as string,
          package: args?.package as string | undefined,
          transportRequest: args?.transport_request as string | undefined,
          thenLabel: args?.then_label as string | undefined,
          elseLabel: args?.else_label as string | undefined,
          thenEventNo: args?.then_event_no as string | undefined,
          elseEventNo: args?.else_event_no as string | undefined,
        });
        break;

      case 'bw_activate_process_chain':
        text = await bwActivateProcessChain(client, args?.name as string);
        break;

      case 'bw_add_process_chain_error_links':
        text = await bwAddProcessChainErrorLinks(client, {
          name: args?.name as string,
          dtps: args?.dtps as string[] | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_swap_process_chain_dtp':
        text = await bwSwapProcessChainDtp(client, {
          name: args?.name as string,
          oldDtp: args?.old_dtp as string,
          newDtp: args?.new_dtp as string,
          refreshDescription: (args?.refresh_description as boolean | undefined) ?? true,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_append_process_chain_dtp':
        text = await bwAppendProcessChainDtp(client, {
          name: args?.name as string,
          dtp: args?.dtp as string,
          adsoact: args?.adsoact as string | undefined,
          before: args?.before as string | undefined,
          after: args?.after as string | undefined,
          predecessor: args?.predecessor as string | undefined,
          edgeMode: args?.edge_mode as 'both' | 'success_only' | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_add_process_chain_program':
        text = await bwAddProcessChainProgram(client, {
          name: args?.name as string,
          program: args?.program as string,
          variant: args?.variant as string | undefined,
          description: args?.description as string | undefined,
          before: args?.before as string | undefined,
          after: args?.after as string | undefined,
          predecessor: args?.predecessor as string | undefined,
          edgeMode: args?.edge_mode as 'both' | 'success_only' | undefined,
          programPackage: args?.program_package as string | undefined,
          programDescription: args?.program_description as string | undefined,
          variantDescription: args?.variant_description as string | undefined,
          synchronous: args?.synchronous as boolean | undefined,
          local: args?.local as boolean | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_add_process_chain_edge':
        text = await bwAddProcessChainEdge(client, {
          name: args?.name as string,
          from: args?.from as string,
          to: args?.to as string,
          status: args?.status as EdgeStatus | undefined,
          subStatus: args?.sub_status as string | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_remove_process_chain_edge':
        text = await bwRemoveProcessChainEdge(client, {
          name: args?.name as string,
          from: args?.from as string,
          to: args?.to as string,
          status: args?.status as EdgeStatus | undefined,
          subStatus: args?.sub_status as string | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_remove_process_chain_step':
        text = await bwRemoveProcessChainStep(client, {
          name: args?.name as string,
          step: args?.step as string,
          reconnect: (args?.reconnect as boolean | undefined) ?? true,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_create_transport_task':
        text = await bwCreateTransportTask(client, {
          transportRequest: args?.transport_request as string,
          user: args?.user as string,
        });
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Return as error content so Claude can see the details
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

/**
 * Build an MCP server with every tool registered.
 *
 * A factory rather than a module-level instance: the SDK binds a Server to exactly one
 * transport for its lifetime, so the stateless HTTP transport needs a fresh one per
 * request. stdio calls this once.
 */
export function createServer(): Server {
  const server = new Server(
    { name: 'bw-modeling-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    // Hide what the caller may not invoke, so a model never proposes a denied call.
    tools: filterToolsByScope(TOOL_DEFINITIONS, extra.authInfo),
  }));

  server.setRequestHandler(CallToolRequestSchema, handleToolCall);

  return server;
}

/**
 * Populate MEDIA_TYPES on first use rather than at startup.
 *
 * The HTTP transport has no credentials at boot — they arrive with the request — so
 * discovery cannot run there. The type->MIME map is system metadata, identical for every
 * caller, so one process-wide cache is correct.
 *
 * Cleared on failure: otherwise one transient error during the very first request would
 * leave the fallbacks in place for the life of the process, and later reads would fail
 * with a misleading "object type not supported on this system".
 */
let discovery: Promise<void> | null = null;
export function ensureMediaTypes(client: BwClient): Promise<void> {
  if (!discovery) {
    discovery = client.loadMediaTypes().catch((err) => {
      discovery = null;
      process.stderr.write(`[bw-modeling-mcp] Warning: discovery failed, using hardcoded media type fallbacks (${err})\n`);
    });
  }
  return discovery;
}

// ── Start (stdio) ─────────────────────────────────────────────────────────────

export async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  // Log to stderr only (stdout is used for MCP protocol messages)
  process.stderr.write('bw-modeling-mcp server started\n');
}

// ── Backward-compatible entrypoint ──────────────────────────────────────────────
//
// Historically the stdio server was launched via `node dist/index.js`, and many local
// MCP client configs still point there. The BTP refactor turned this file into a shared
// module imported by stdio.ts and http.ts, so it no longer self-started. Restore the old
// behaviour: start the stdio server when this file is the process entry point. When it is
// imported (stdio.ts / http.ts), import.meta.url differs from argv[1], so this is a no-op
// and never double-starts.
function isRunAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  startStdio().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
