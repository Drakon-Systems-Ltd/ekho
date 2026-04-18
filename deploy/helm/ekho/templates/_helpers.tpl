{{/*
Expand the name of the chart.
*/}}
{{- define "ekho.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to
this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "ekho.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "ekho.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "ekho.labels" -}}
helm.sh/chart: {{ include "ekho.chart" . }}
{{ include "ekho.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ekho
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "ekho.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ekho.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Create the name of the service account to use.
*/}}
{{- define "ekho.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ekho.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Secret name — use existingSecret if provided, otherwise generated name.
*/}}
{{- define "ekho.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "ekho.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
ConfigMap name.
*/}}
{{- define "ekho.configMapName" -}}
{{- printf "%s-config" (include "ekho.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
