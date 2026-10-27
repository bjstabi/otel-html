/**
 * Semantic-convention attribute names used for presentation. Copied as string constants (not
 * imported) because incubating conventions must not be depended on at runtime, per the OTel JS
 * guidance. Source: OpenTelemetry semantic conventions v1.43.0 (https://opentelemetry.io/docs/specs/semconv/).
 */
export const ATTR_SERVICE_NAME = 'service.name';
export const ATTR_HTTP_REQUEST_METHOD = 'http.request.method';
export const ATTR_HTTP_ROUTE = 'http.route';
export const ATTR_HOST_NAME = 'host.name';
export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
