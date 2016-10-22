// This file contains the functions for processing incoming data from
// the agent instrumentation and reporting it back to the optics
// backend.


import os from 'os';
import request from 'request';
import { graphql } from 'graphql';
import { visit, visitWithTypeInfo, print } from 'graphql/language';
import {
  getNamedType,
  GraphQLObjectType,
} from 'graphql/type';
import { TypeInfo } from 'graphql/utilities';


import {
  printType,
  latencyBucket, newLatencyBuckets, addLatencyToBuckets, trimLatencyBuckets,
} from './Normalize';

import {
  Timestamp, Trace, ReportHeader,
  TracesReport, StatsReport, SchemaReport,
  StatsPerSignature, StatsPerClientName,
  FieldStat, TypeStat, Field, Type,
} from './Proto';

// Babel cleverly inlines the require below!
// eslint-disable-next-line global-require
const VERSION = `optics-agent-js ${require('../package.json').version}`;


// //////// Helpers ////////

export const getTypesFromSchema = (schema) => {
  const ret = [];
  const typeMap = schema.getTypeMap();
  const typeNames = Object.keys(typeMap);
  typeNames.forEach((typeName) => {
    const type = typeMap[typeName];
    if (getNamedType(type).name.startsWith('__') ||
        !(type instanceof GraphQLObjectType)) {
      return;
    }
    const t = new Type();
    t.name = typeName;
    t.field = [];
    const fields = type.getFields();
    Object.keys(fields).forEach((fieldName) => {
      const field = fields[fieldName];
      const f = new Field();
      f.name = fieldName;
      f.returnType = printType(field.type);
      t.field.push(f);
    });
    ret.push(t);
  });
  return ret;
};

// Converts an hrtime array (as returned from process.hrtime) to nanoseconds.
//
// ONLY CALL THIS ON VALUES REPRESENTING DELTAS, NOT ON THE RAW RETURN VALUE
// FROM process.hrtime() WITH NO ARGUMENTS.
//
// The entire point of the hrtime data structure is that the JavaScript Number
// type can't represent all int64 values without loss of precision:
// Number.MAX_SAFE_INTEGER nanoseconds is about 104 days. Calling this function
// on a duration that represents a value less than 104 days is fine. Calling
// this function on an absolute time (which is generally roughly time since
// system boot) is not a good idea.
const durationHrTimeToNanos = hrtime => ((hrtime[0] * 1e9) + hrtime[1]);

// //////// Sending Data ////////

export const sendMessage = (agent, path, message) => {
  const headers = {
    'user-agent': 'optics-agent-js',
  };
  if (agent.apiKey) {
    headers['x-api-key'] = agent.apiKey;
  }

  const options = {
    url: agent.endpointUrl + path,
    method: 'POST',
    headers,
    body: message.encode().toBuffer(),
  };
  request(options, (err, res, body) => {
    // XXX add retry logic
    // XXX add separate flag for disable printing errors?
    if (err) {
      console.log('OPTICS Error trying to report to optics backend:', err.message);  // eslint-disable-line no-console
    } else if (res.statusCode < 200 || res.statusCode > 299) {
      console.log('OPTICS Backend error', res.statusCode, body);  // eslint-disable-line no-console
    }

    if (agent.printReports) {
      console.log('OPTICS', path, message.encodeJSON(), body);  // eslint-disable-line no-console
    }
  });
};


//  //////// Marshalling Data ////////

export const sendReport = (agent, reportData, startTime, endTime, durationHr) => {
  try {
    // build report protobuf object
    const report = new StatsReport();
    report.header = new ReportHeader({
      hostname: os.hostname(),
      agent_version: VERSION,
      runtime_version: `node ${process.version}`,
      // XXX not actually uname, but what node has easily.
      uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`,
    });

    report.start_time = new Timestamp(
      { seconds: (endTime / 1000), nanos: (endTime % 1000) * 1e6 });
    report.end_time = new Timestamp(
      { seconds: (startTime / 1000), nanos: (startTime % 1000) * 1e6 });
    report.realtime_duration = durationHrTimeToNanos(durationHr);

    report.type = getTypesFromSchema(agent.schema);

    // fill out per signature
    report.per_signature = {};
    Object.keys(reportData).forEach((query) => {
      const c = new StatsPerSignature();

      // add client stats
      c.per_client_name = {};
      const clients = reportData[query].perClient;
      Object.keys(clients).forEach((client) => {
        const versions = clients[client].perVersion;
        const v = new StatsPerClientName();
        v.latency_count = trimLatencyBuckets(clients[client].latencyBuckets);
        v.count_per_version = {};
        Object.keys(versions).forEach((version) => {
          const r = versions[version];
          v.count_per_version[version] = r;
        });
        c.per_client_name[client] = v;
      });

      // add field stats
      c.per_type = [];
      const fields = reportData[query].perField;
      Object.keys(fields).forEach((parentType) => {
        const ts = new TypeStat();
        c.per_type.push(ts);
        ts.name = parentType;
        ts.field = [];
        Object.keys(fields[parentType]).forEach((fieldName) => {
          const fs = new FieldStat();
          ts.field.push(fs);
          const fObj = fields[parentType][fieldName];
          fs.name = fieldName;
          fs.returnType = fObj.returnType;
          fs.latency_count = trimLatencyBuckets(fObj.latencyBuckets);
        });
      });

      report.per_signature[query] = c;
    });

    sendMessage(agent, '/api/ss/stats', report);
  } catch (e) {
    console.log('EEE', e);  // eslint-disable-line no-console
  }
};


export const sendTrace = (agent, context, info, resolvers) => {
  // exceptions from here are caught and ignored somewhere.
  // catch manually for debugging.
  try {
    const report = new TracesReport();
    report.header = new ReportHeader({
      hostname: os.hostname(),
      agent_version: VERSION,
      runtime_version: `node ${process.version}`,
      // XXX not actually uname, but what node has easily.
      uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`,
    });
    const req = context.req;

    const trace = new Trace();
    // XXX make up a server_id
    trace.start_time = new Timestamp(
      { seconds: (context.startWallTime / 1000),
        nanos: (context.startWallTime % 1000) * 1e6 });
    trace.end_time = new Timestamp(
      { seconds: (context.endWallTime / 1000),
        nanos: (context.endWallTime % 1000) * 1e6 });
    trace.duration_ns = durationHrTimeToNanos(context.durationHrTime);

    trace.signature = agent.normalizeQuery(info);

    trace.details = new Trace.Details();
    const operationStr = print(info.operation);
    const fragmentsStr = Object.keys(info.fragments).map(k => print(info.fragments[k])).join('\n');
    trace.details.raw_query = `${operationStr}\n${fragmentsStr}`;
    if (info.operation.name) {
      trace.details.operation_name = print(info.operation.name);
    }
    if (agent.reportVariables) {
      trace.details.variables = {};
      for (const k of Object.keys(info.variableValues)) {
        trace.details.variables[k] = JSON.stringify(info.variableValues[k]);
      }
    }

    const { client_name, client_version } = agent.normalizeVersion(req);
    trace.client_name = client_name;  // eslint-disable-line camelcase
    trace.client_version = client_version;  // eslint-disable-line camelcase

    trace.client_addr = req.connection.remoteAddress; // XXX x-forwarded-for?
    trace.http = new Trace.HTTPInfo();
    trace.http.host = req.headers.host;
    trace.http.path = req.url;

    trace.execute = new Trace.Node();
    trace.execute.child = resolvers.map((rep) => {
      // XXX for now we just list all the resolvers in a flat list.
      //
      // With graphql 0.6.1+ we have the path field in resolverInfo so
      // we should make these into a hierarchical list.
      // See: https://github.com/apollostack/optics-agent-js/issues/34
      const n = new Trace.Node();
      n.field_name = `${rep.fieldInfo.typeName}.${rep.fieldInfo.fieldName}`;
      n.type = printType(rep.resolverInfo.returnType);
      n.start_time = durationHrTimeToNanos(rep.startOffset);
      n.end_time = durationHrTimeToNanos(rep.endOffset);
      return n;
    });

    // no batching for now.
    report.trace = [trace];

    sendMessage(agent, '/api/ss/traces', report);
  } catch (e) {
    console.log('EEE', e);  // eslint-disable-line no-console
  }
};

export const sendSchema = (agent, schema) => {
  // modified introspection query that doesn't return something
  // quite so giant.
  const q = `
  query ShorterIntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        # description
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    # description
    fields(includeDeprecated: true) {
      name
      # description
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      # deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      # description
      isDeprecated
      # deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    # description
    type { ...TypeRef }
    # defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }

`;
  graphql(schema, q).then(
    (res) => {
      if (!res || !res.data || !res.data.__schema) {
        // XXX huh?
        console.log('Bad schema result');  // eslint-disable-line no-console
        return;
      }
      const resultSchema = res.data.__schema;
      // remove the schema schema from the schema.
      resultSchema.types = resultSchema.types.filter(
        x => x && (x.kind !== 'OBJECT' || x.name !== '__Schema')
      );

      const schemaString = JSON.stringify(resultSchema);

      const report = new SchemaReport();
      report.header = new ReportHeader({
        hostname: os.hostname(),
        agent_version: VERSION,
        runtime_version: `node ${process.version}`,
        // XXX not actually uname, but what node has easily.
        uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`,
      });
      report.introspection_result = schemaString;
      report.type = getTypesFromSchema(schema);

      sendMessage(agent, '/api/ss/schema', report);
    }
  );
  // ).catch(() => {}); // XXX!
};


// //////// Incoming Data ////////

// Called once per query at query start time by graphql-js.
export const reportRequestStart = (context, queryInfo, queryContext) => {
  if (!context || !queryInfo || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }

  // This may be called more than once per request, for example
  // apollo-server can batch multiple requests in a single POST (aka
  // Transport Level Batching).
  //
  // We keep track of each info object separately, along with the
  // `context` object passed to the query, and use these to determine
  // which resolver runs correspond to which query.
  //
  // Store as a Map of `context` => [ { info, context, resolvers } ] objects.
  //
  // This is a contract between reportRequestStart and reportRequestEnd.
  //
  // Note: we use a Map instead of simple array to avoid doing O(N^2)
  // work on a batch with a lot of queries, each with a separate
  // context object. We store a list in each map item in case the
  // caller does not allocate a new context object per query and we
  // see a duplicate context object.
  if (!context.queries) {
    context.queries = new Map(); // eslint-disable-line no-param-reassign
  }
  if (!context.queries.has(queryContext)) {
    context.queries.set(queryContext, []);
  }
  context.queries.get(queryContext).push({
    info: queryInfo,
    resolvers: [],
  });
};

export const reportTrace = (agent, context, info, resolvers) => {
  // For now just send every trace immediately. We might want to add
  // batching here at some point.
  //
  // Send in its own function on the event loop to minimize impact on
  // response times.
  setImmediate(() => sendTrace(agent, context, info, resolvers));
};

// called once per query by the middleware when the request ends.
export const reportRequestEnd = (req) => {
  const context = req._opticsContext;
  if (!context || !context.queries || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }

  const queries = context.queries;
  const agent = context.agent;

  try {
    // Separate out resolvers into buckets by query. To determine
    // which query a resolver corresponds to in the case of multiple
    // queries per HTTP request, we look at the GraphQL `context` and
    // `operation` objects which are available both at query start
    // time and during resolver runs.
    //
    // Implementations that do batching of GraphQL requests (such as
    // apollo-server) should use a separate `context` object for each
    // request in the batch. Shallow cloning is sufficient.
    //
    // For backwards compatibility with older versions of
    // apollo-server, and potentially with other graphql integrations,
    // we also look at the `operation` object. This will be different
    // for each query in the batch unless the application is using
    // pre-prepared queries and the user sends multiple queries for
    // the same operation in the same batch.
    (context.resolverCalls || []).forEach((resolverReport) => {
      // check the report is complete.
      if (!resolverReport.resolverInfo ||
          !resolverReport.resolverInfo.operation ||
          !resolverReport.fieldInfo ||
          !resolverReport.startOffset ||
          !resolverReport.endOffset) {
        return;
      }

      for (const queryObj of (queries.get(resolverReport.resolverContext) || [])) {
        if (resolverReport.resolverInfo.operation === queryObj.info.operation) {
          queryObj.resolvers.push(resolverReport);
          break;
        }
      }
    });

    // Iterate over each query in this request and aggregate its
    // timing and resolvers.
    queries.forEach((queryList) => {
      queryList.forEach(({ info, resolvers: queryResolvers = [] }) => {
        const query = agent.normalizeQuery(info);
        const { client_name, client_version } = agent.normalizeVersion(req);
        const res = agent.pendingResults;

        // Initialize per-query state in the report if we're the first of
        // this query shape to come in this report period.
        if (!res[query]) {
          res[query] = {
            perClient: {},
            perField: {},
          };
        }

        // fill out per field if we haven't already for this query shape.
        const perField = res[query].perField;
        if (Object.keys(perField).length === 0) {
          const typeInfo = new TypeInfo(agent.schema);
          visit(info.operation, visitWithTypeInfo(typeInfo, {
            Field: () => {
              const parentType = typeInfo.getParentType().name;
              if (!perField[parentType]) {
                perField[parentType] = {};
              }
              const fieldName = typeInfo.getFieldDef().name;
              perField[parentType][fieldName] = {
                returnType: printType(typeInfo.getType()),
                latencyBuckets: newLatencyBuckets(),
              };
            },
          }));
        }

        // initialize latency buckets if this is the first time we've had
        // a query from this client type in this period.
        const perClient = res[query].perClient;
        if (!perClient[client_name]) {
          perClient[client_name] = {
            latencyBuckets: newLatencyBuckets(),
            perVersion: {},
          };
        }

        // now that we've initialized, this should always be set.
        const clientObj = (
          res[query] && res[query].perClient && res[query].perClient[client_name]);

        if (!clientObj) {
          // XXX huh?
          console.log('CC2', query);  // eslint-disable-line no-console
          return;
        }

        const nanos = durationHrTimeToNanos(context.durationHrTime);

        // add query latency to buckets
        addLatencyToBuckets(clientObj.latencyBuckets, nanos);

        // add per-client version count to buckets
        const perVersion = clientObj.perVersion;
        if (!perVersion[client_version]) {
          perVersion[client_version] = 0;
        }
        perVersion[client_version] += 1;

        // now iterate over our resolvers and add them to the latency buckets.
        queryResolvers.forEach((resolverReport) => {
          const { typeName, fieldName } = resolverReport.fieldInfo;
          if (resolverReport.endOffset && resolverReport.startOffset) {
            const resolverNanos =
                    durationHrTimeToNanos(resolverReport.endOffset) -
                    durationHrTimeToNanos(resolverReport.startOffset);
            const fObj = res &&
                    res[query] &&
                    res[query].perField &&
                    res[query].perField[typeName] &&
                    res[query].perField[typeName][fieldName];
            if (!fObj) {
              // XXX when could this happen now?
              return;
            }
            addLatencyToBuckets(fObj.latencyBuckets, resolverNanos);
          }
        });


        // check to see if we've sent a trace for this bucket yet this
        // report period. if we haven't (ie, if we're the only query in
        // this bucket), send one now.
        const bucket = latencyBucket(nanos);
        const numSoFar = clientObj.latencyBuckets[bucket];
        if (numSoFar === 1 && agent.reportTraces) {
          reportTrace(agent, context, info, queryResolvers);
        }
      });
    });
  } catch (e) {
    // XXX https://github.com/apollostack/optics-agent-js/issues/17
    console.log('EEE', e);  // eslint-disable-line no-console
  }
};

export const reportSchema = (agent, schema) => {
  // Sent once on startup. Wait 10 seconds to report the schema. This
  // does two things:
  // - help apps start up and serve users faster. don't clog startup
  //   time with reporting.
  // - avoid sending a ton of reports from a crash-looping server.
  setTimeout(() => sendSchema(agent, schema), 10 * 1000);
};
