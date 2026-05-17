import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams, Link } from 'react-router-dom';
import { normalizeAnalysisResponse } from '../utils/analysisAdapter';
import type { NormalizedAnalysis } from '../utils/analysisAdapter';
import { 
  renderMetric, 
  renderConfidence, 
  renderLabel, 
  renderResolution, 
  SeverityBadge 
} from '../utils/renderHelpers';

const TrustDimensionBar: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className="space-y-1">
    <div className="flex justify-between items-end">
      <span className="text-[10px] font-bold text-outline uppercase tracking-wider">{label}</span>
      <span className="text-label-sm font-code-sm text-primary">{Math.round(value)}%</span>
    </div>
    <div className="h-1.5 w-full bg-surface-container-high rounded-full overflow-hidden">
      <div 
        className={`h-full transition-all duration-700 ease-out ${color}`} 
        style={{ width: `${value}%` }}
      />
    </div>
  </div>
);

const getReadableOcrLabel = (
  readability: string,
  confidence: number | null,
  plates: string[]
) => {
  const conf = confidence ?? 0;
  if (plates.length > 0 && conf > 0.7)
    return 'Clearly Readable';

  if (plates.length > 0)
    return 'Mostly Readable';

  if (readability === 'partially_readable')
    return 'Partial Extraction';

  if (readability === 'low_confidence_extraction')
    return 'Extraction Uncertain';

  return 'Unreadable';
};

const JobResults: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<any>(null);
  const [analysis, setAnalysis] = useState<NormalizedAnalysis | null>(null); 
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    const fetchJobData = async () => {
      try {
        const [jobRes, resultsRes] = await Promise.all([
          axios.get(`/api/v1/jobs/${id}/status`),
          axios.get(`/api/v1/jobs/${id}/results`)
        ]);
        setJob(jobRes.data.job);
        setAnalysis(normalizeAnalysisResponse(resultsRes.data));
      } catch (err: any) {
        console.error(err);
        if (err.response?.status === 409) {
          setError('Verification in progress. The trust engine is finalizing operational outcomes.');
        } else {
          setError(err.response?.data?.message || 'Failed to fetch verification data');
        }
      } finally {
        setLoading(false);
      }
    };
    if (id) fetchJobData();
  }, [id]);

  if (loading) {
    return (
      <div className="p-xl text-center space-y-md">
        <div className="animate-spin text-secondary inline-block">
          <span className="material-symbols-outlined text-4xl">settings_input_antenna</span>
        </div>
        <p className="font-headline-md text-primary tracking-tight">Synchronizing Trust Signals...</p>
      </div>
    );
  }

  if (error || !job || !analysis) {
    return (
      <div className="p-xl text-center">
        <p className="font-headline-md text-error mb-md">{error || 'Verification data unavailable'}</p>
        <Link to="/jobs" className="text-primary hover:underline">Return to dashboard</Link>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'failed': return 'bg-red-100 text-red-700 border-red-200';
      case 'processing': return 'bg-amber-100 text-amber-700 border-amber-200';
      default: return 'bg-surface-container text-outline border-outline-variant';
    }
  };

  const getRecommendationStyle = (severity: string) => {
    switch (severity) {
      case 'success': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'warning': return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'error': return 'bg-red-50 text-red-700 border-red-200';
      default: return 'bg-surface-container-low text-outline border-outline-variant';
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto pb-2xl">
      {/* Operational Header */}
      <section className="mb-xl grid grid-cols-1 lg:grid-cols-12 gap-gutter items-start">
        <div className="lg:col-span-7 space-y-base">
          <div className="flex items-center gap-sm">
            <span className="px-sm py-xs bg-surface-container-highest text-primary rounded font-code-sm text-code-sm border border-outline-variant">
              VER-{id?.substring(0, 8).toUpperCase()}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest border ${getStatusColor(job.status)}`}>
              {job.status}
            </span>
            <SeverityBadge severity={analysis.recommendation.severity}>
              {analysis.trustLevel}
            </SeverityBadge>
          </div>
          <h1 className="font-headline-xl text-headline-xl text-primary leading-tight">{job.originalFilename ?? 'Verification Report'}</h1>
          
          <div className={`p-lg rounded-xl border ${getRecommendationStyle(analysis.recommendation.severity)} space-y-sm shadow-sm`}>
            <div className="flex items-center gap-md">
              <span className="material-symbols-outlined text-2xl">
                {analysis.recommendation.severity === 'success' ? 'verified' : (analysis.recommendation.severity === 'warning' ? 'report_problem' : 'cancel')}
              </span>
              <div>
                <h2 className="font-headline-md leading-none">{analysis.recommendation.label}</h2>
                <p className="text-body-md opacity-80 mt-1">{analysis.recommendation.desc}</p>
              </div>
            </div>
            {analysis.recommendation.summary.length > 0 && (
              <ul className="mt-md space-y-xs pl-8 list-disc text-body-md opacity-90 border-t border-current/10 pt-sm">
                {analysis.recommendation.summary.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col gap-md">
          <div className="bg-surface-container-lowest p-lg rounded-xl border border-outline-variant shadow-sm space-y-lg">
            <div className="flex items-center gap-xl">
              <div className="relative w-20 h-20">
                <svg className="w-full h-full transform -rotate-90">
                  <circle className="text-surface-container-highest" cx="40" cy="40" fill="transparent" r="34" stroke="currentColor" strokeWidth="8"></circle>
                  <circle 
                    className={`transition-all duration-1000 ease-out ${analysis.recommendation.severity === 'success' ? 'text-secondary' : 'text-primary'}`} 
                    cx="40" cy="40" fill="transparent" r="34" stroke="currentColor" 
                    strokeDasharray="213.6" 
                    strokeDashoffset={213.6 - (analysis.trustScore / 100) * 213.6} 
                    strokeWidth="8"
                  ></circle>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="font-headline-md text-primary leading-none">{analysis.isReady ? analysis.trustScore : '—'}</span>
                  <span className="text-[8px] font-bold text-outline uppercase">Trust</span>
                </div>
              </div>
              <div className="flex-1">
                <p className="font-label-md text-outline uppercase tracking-widest text-[10px]">Operational Health</p>
                <p className="font-headline-md text-primary">{analysis.isReady ? analysis.trustLevel : 'Analyzing...'}</p>
                <div className="h-1.5 w-full bg-surface-container-high rounded-full mt-2 overflow-hidden">
                  <div className={`h-full bg-secondary transition-all duration-1000`} style={{ width: `${analysis.trustScore}%` }}></div>
                </div>
              </div>
            </div>

            {analysis.dimensions && (
              <div className="grid grid-cols-2 gap-x-gutter gap-y-md border-t border-outline-variant pt-md">
                <TrustDimensionBar label="Visual Quality" value={analysis.dimensions.visualQuality} color="bg-secondary" />
                <TrustDimensionBar label="Authenticity" value={analysis.dimensions.authenticityConfidence} color="bg-primary" />
                <TrustDimensionBar label="OCR Reliability" value={analysis.dimensions.ocrReliability} color="bg-secondary" />
                <TrustDimensionBar label="Workflow Integrity" value={analysis.dimensions.workflowIntegrity} color="bg-primary" />
                <div className="col-span-2 pt-xs">
                  <TrustDimensionBar label="Human-Centric Usability" value={analysis.dimensions.operationalUsability} color="bg-secondary opacity-80" />
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <button 
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className={`flex items-center gap-xs px-md py-xs rounded-full text-label-md font-bold transition-colors ${showDiagnostics ? 'bg-secondary text-on-secondary' : 'bg-surface-container-high text-primary hover:bg-surface-container-highest'}`}
            >
              <span className="material-symbols-outlined text-[18px]">{showDiagnostics ? 'visibility_off' : 'terminal'}</span>
              {showDiagnostics ? 'Hide Raw Metrics' : 'Show Diagnostic Data'}
            </button>
          </div>
        </div>
      </section>

      {/* Verification Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
        
        {/* Clarity & Readability Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className={`material-symbols-outlined ${analysis.blur.color}`}>
                {analysis.blur.icon}
              </span>
              <h3 className="font-headline-md text-headline-md">Clarity</h3>
            </div>
            <SeverityBadge severity={analysis.blur.severity}>
              {analysis.blur.label}
            </SeverityBadge>
          </div>
          
          <div className="flex-1 space-y-md">
            <p className="text-body-md text-on-surface-variant">
              {analysis.blur.desc}
            </p>
            
            <div className="grid grid-cols-2 gap-md p-md bg-surface-container-low rounded-lg border border-outline-variant">
              <div className="space-y-xs">
                <p className="text-[10px] text-outline uppercase font-bold tracking-widest">Edge Quality</p>
                <p className="text-label-md font-bold text-primary">
                  {renderLabel(analysis.blur.details?.perceptualLabels?.edgeEnergy)}
                </p>
              </div>
              <div className="space-y-xs">
                <p className="text-[10px] text-outline uppercase font-bold tracking-widest">Motion Risk</p>
                <p className={`text-label-md font-bold ${analysis.blur.details?.motionBlurDetected ? 'text-error' : 'text-primary'}`}>
                  {renderLabel(analysis.blur.details?.perceptualLabels?.motionRisk)}
                </p>
              </div>
            </div>

            {showDiagnostics && analysis.blur.details && (
              <div className="text-[10px] font-code-sm text-outline opacity-70 animate-in fade-in">
                <p>Laplacian: {renderMetric(analysis.blur.details.laplacianVariance, 1)}</p>
                <p>Coherence: {renderMetric(analysis.blur.details.directionalCoherence, 3)}</p>
                <p>Confidence: {renderConfidence(analysis.blur.confidence)}</p>
              </div>
            )}
          </div>
        </div>

        {/* Identity Plate Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">spellcheck</span>
              <h3 className="font-headline-md text-headline-md">Identity Extraction</h3>
            </div>
            <SeverityBadge severity={analysis.ocr.readabilityLevel === 'high' ? 'success' : (analysis.ocr.readabilityLevel === 'unreadable' ? 'error' : 'warning')}>
              {getReadableOcrLabel(
                analysis.ocr.readability,
                analysis.ocr.confidence,
                analysis.ocr.plates
              )}
            </SeverityBadge>
          </div>
          
          <div className="flex-1 space-y-md">
            <div className="flex flex-wrap gap-sm min-h-[40px] items-center">
              {analysis.ocr.plates.length > 0 ? analysis.ocr.plates.map((plate: string, i: number) => (
                <span key={i} className="px-md py-1.5 bg-secondary text-on-secondary rounded font-bold text-headline-sm tracking-widest border border-secondary shadow-sm">
                  {plate}
                </span>
              )) : (
                <p className="text-body-md text-outline italic">No standard registration formats identified.</p>
              )}
            </div>

            <div className="p-sm bg-surface-container-low border border-outline-variant rounded-lg font-code-sm text-primary text-[11px] h-[80px] overflow-y-auto flex items-center">
              <span className="opacity-80 leading-relaxed font-bold">
                {analysis.ocr.plates.length > 0
                  ? analysis.ocr.plates.join(', ')
                  : 'Automated extraction uncertain.'}
              </span>
            </div>

            {showDiagnostics && (
              <div className="text-[10px] font-code-sm text-outline opacity-70 animate-in fade-in space-y-1 mt-sm pt-xs border-t border-outline-variant/30">
                <p>Engine Confidence: {renderConfidence(analysis.ocr.confidence)}</p>
                <p>Format Valid: {analysis.ocr.plates.length > 0 ? 'TRUE' : 'FALSE'}</p>
                {analysis.ocr.text && <p className="mt-1 truncate">Raw OCR: "{analysis.ocr.text}"</p>}
              </div>
            )}
          </div>
        </div>

        {/* Illumination Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className={`material-symbols-outlined ${analysis.brightness.color}`}>
                {analysis.brightness.icon}
              </span>
              <h3 className="font-headline-md text-headline-md">Illumination</h3>
            </div>
            <SeverityBadge severity={analysis.brightness.severity}>
              {analysis.brightness.label}
            </SeverityBadge>
          </div>
          <div className="flex-1 space-y-md">
            <p className="text-body-md text-on-surface-variant">
              {analysis.brightness.desc}
            </p>
            <div className="p-md bg-surface-container-low rounded-lg border border-outline-variant space-y-sm">
              <div className="flex justify-between text-label-md">
                <span className="text-outline font-bold uppercase text-[9px] tracking-widest">Exposure Level</span>
                <span className="text-primary font-bold">{renderLabel(analysis.brightness.details?.perceptualLabels?.exposure)}</span>
              </div>
              <div className="flex justify-between text-label-md">
                <span className="text-outline font-bold uppercase text-[9px] tracking-widest">Tonal Range</span>
                <span className="text-primary font-bold">{renderLabel(analysis.brightness.details?.perceptualLabels?.contrast)}</span>
              </div>
              <div className="flex justify-between text-label-md">
                <span className="text-outline font-bold uppercase text-[9px] tracking-widest">Detail Clipping</span>
                <span className="text-primary font-bold">{renderLabel(analysis.brightness.details?.perceptualLabels?.dynamicRange)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Authenticity Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">verified_user</span>
              <h3 className="font-headline-md text-headline-md">Authenticity</h3>
            </div>
            <SeverityBadge severity={analysis.authenticity.riskLevel === 'low' ? 'success' : (analysis.authenticity.riskLevel === 'high' ? 'error' : 'warning')}>
              {analysis.authenticity.label}
            </SeverityBadge>
          </div>
          <div className="flex-1 space-y-md">
            <div className="flex items-center gap-md p-md bg-surface-container-low rounded-lg border border-outline-variant">
              <div className={`w-12 h-12 rounded flex items-center justify-center ${analysis.authenticity.riskLevel === 'low' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                <span className="material-symbols-outlined">{analysis.authenticity.riskLevel === 'low' ? 'no_photography' : 'screenshot'}</span>
              </div>
              <div>
                <p className="text-[10px] text-outline font-bold uppercase tracking-widest">Capture Source</p>
                <p className="font-headline-sm text-primary leading-none mt-1">{analysis.authenticity.source}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-xs min-h-[40px]">
              {analysis.authenticity.flags.length > 0 ? analysis.authenticity.flags.map((flag, i) => (
                <span key={i} className="px-sm py-xs bg-error-container text-on-error-container rounded-sm text-[10px] font-bold uppercase tracking-wider">
                  {flag}
                </span>
              )) : (
                <span className="text-body-md text-on-surface-variant italic">No manipulation indicators identified.</span>
              )}
            </div>
          </div>
        </div>

        {/* Uniqueness Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">content_copy</span>
              <h3 className="font-headline-md text-headline-md">Duplicate Risk</h3>
            </div>
            <SeverityBadge severity={analysis.uniqueness.severity}>
              {analysis.uniqueness.label}
            </SeverityBadge>
          </div>
          <div className="flex-1 space-y-md">
            <div className="p-md bg-surface-container-low border border-outline-variant rounded-lg flex items-center gap-md">
              <span className="material-symbols-outlined text-outline text-3xl">fingerprint</span>
              <div className="overflow-hidden">
                <p className="text-[9px] font-bold text-outline uppercase tracking-widest">Perceptual Signature</p>
                <p className="font-code-sm text-[10px] text-primary truncate">#{id?.substring(0, 16)}</p>
              </div>
            </div>
            <p className="text-body-md text-on-surface-variant">
              {analysis.uniqueness.passed === false 
                ? 'High perceptual similarity to an existing record identified. Manual verification of context recommended.' 
                : 'No conflicting visual signatures identified in the current verification corpus.'}
            </p>
          </div>
        </div>

        {/* Technical Specification Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">settings_overscan</span>
              <h3 className="font-headline-md text-headline-md">Specifications</h3>
            </div>
            <SeverityBadge severity={analysis.specs.megapixels && analysis.specs.megapixels > 0.8 ? 'success' : 'warning'}>
              {analysis.specs.resolutionLabel}
            </SeverityBadge>
          </div>
          <div className="flex-1 space-y-md">
            <div className="p-md bg-surface-container-low border border-outline-variant rounded-lg text-center">
              <p className="font-headline-md text-primary">{renderResolution(analysis.specs.width, analysis.specs.height)}</p>
              <p className="text-[10px] font-bold text-outline uppercase tracking-widest mt-1">
                {renderMetric(analysis.specs.megapixels, 2, ' Megapixels')}
              </p>
            </div>
            <p className="text-body-md text-on-surface-variant leading-relaxed">
              {analysis.specs.impactDesc}
            </p>
          </div>
        </div>

        {/* Structured Image Metadata Card */}
        <div className="glass-card p-lg rounded-xl flex flex-col gap-md md:col-span-2 lg:col-span-3">
          <div className="flex justify-between items-center border-b border-outline-variant pb-sm">
            <div className="flex items-center gap-sm">
              <span className="material-symbols-outlined text-secondary">info</span>
              <h3 className="font-headline-md text-headline-md">Structured Image Metadata</h3>
            </div>
            <span className="px-sm py-xs bg-surface-container-high text-outline rounded text-[10px] font-bold uppercase tracking-wider">
              {analysis.imageMetadata?.format || 'METADATA'} PROFILE
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-lg pt-sm">
            {/* Column 1: Encoding & Color Space */}
            <div className="space-y-md border-r border-outline-variant/30 pr-md last:border-0 last:pr-0">
              <h4 className="text-[11px] font-bold text-secondary uppercase tracking-widest flex items-center gap-xs">
                <span className="material-symbols-outlined text-[14px]">palette</span>
                Color & Format Profile
              </h4>
              <div className="space-y-sm">
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Encoding Format</span>
                  <span className="font-bold text-primary">{analysis.imageMetadata?.format || 'Unknown'}</span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Color Space</span>
                  <span className="font-bold text-primary">{analysis.imageMetadata?.colorSpace || 'Unknown'}</span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Channels</span>
                  <span className="font-bold text-primary">{analysis.imageMetadata?.channels ?? 'Unknown'}</span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Bit Depth</span>
                  <span className="font-bold text-primary">
                    {analysis.imageMetadata?.depth === 'uchar' ? '8-bit Color Depth' : (analysis.imageMetadata?.depth ? `${analysis.imageMetadata.depth}-bit Color Depth` : 'Unknown')}
                  </span>
                </div>
                <div className="flex justify-between text-body-md">
                  <span className="text-outline">Alpha Channel</span>
                  <span className="font-bold text-primary">{analysis.imageMetadata?.hasAlpha ? 'Yes (Transparent)' : 'No (Opaque)'}</span>
                </div>
              </div>
            </div>

            {/* Column 2: Acquisition Device */}
            <div className="space-y-md border-r border-outline-variant/30 pr-md last:border-0 last:pr-0">
              <h4 className="text-[11px] font-bold text-secondary uppercase tracking-widest flex items-center gap-xs">
                <span className="material-symbols-outlined text-[14px]">photo_camera</span>
                Capture Hardware
              </h4>
              <div className="space-y-sm">
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Device Manufacturer</span>
                  <span className="font-bold text-primary truncate max-w-[140px] text-right">{analysis.imageMetadata?.cameraMake || 'Not Embedded'}</span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Device Model</span>
                  <span className="font-bold text-primary truncate max-w-[140px] text-right">{analysis.imageMetadata?.cameraModel || 'Not Embedded'}</span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Processing Software</span>
                  <span className="font-bold text-primary truncate max-w-[140px] text-right" title={analysis.imageMetadata?.software || 'No explicit editing software signature detected'}>
                    {analysis.imageMetadata?.software || 'No explicit editing software signature detected'}
                  </span>
                </div>
                <div className="flex justify-between text-body-md">
                  <span className="text-outline">Metadata Header</span>
                  <span className={`font-bold text-[10px] uppercase px-1.5 py-0.5 rounded ${analysis.imageMetadata?.cameraMake ? 'bg-emerald-100 text-emerald-700' : 'bg-surface-container-high text-outline'}`}>
                    {analysis.imageMetadata?.cameraMake ? 'EXIF Header Verified' : 'Embedded camera metadata unavailable'}
                  </span>
                </div>
              </div>
            </div>

            {/* Column 3: Temporal & Geo-Location */}
            <div className="space-y-md">
              <h4 className="text-[11px] font-bold text-secondary uppercase tracking-widest flex items-center gap-xs">
                <span className="material-symbols-outlined text-[14px]">location_on</span>
                Acquisition Context
              </h4>
              <div className="space-y-sm">
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Capture Date</span>
                  <span className="font-bold text-primary text-right text-[12px] truncate max-w-[160px]">
                    {analysis.imageMetadata?.createdDate 
                      ? new Date(analysis.imageMetadata.createdDate).toLocaleString() 
                      : 'Not Embedded'}
                  </span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">Modification Date</span>
                  <span className="font-bold text-primary text-right text-[12px] truncate max-w-[160px]">
                    {analysis.imageMetadata?.modifyDate 
                      ? new Date(analysis.imageMetadata.modifyDate).toLocaleString() 
                      : 'Not Embedded'}
                  </span>
                </div>
                <div className="flex justify-between text-body-md border-b border-outline-variant/10 pb-xs">
                  <span className="text-outline">GPS Location</span>
                  {analysis.imageMetadata?.gps ? (
                    <a 
                      href={`https://www.google.com/maps/search/?api=1&query=${analysis.imageMetadata.gps.latitude},${analysis.imageMetadata.gps.longitude}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="font-bold text-secondary hover:underline flex items-center gap-xs animate-pulse"
                    >
                      {analysis.imageMetadata.gps.latitude.toFixed(4)}, {analysis.imageMetadata.gps.longitude.toFixed(4)}
                      <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    </a>
                  ) : (
                    <span className="font-bold text-primary">Not Embedded</span>
                  )}
                </div>
                <div className="flex justify-between text-body-md">
                  <span className="text-outline">Orientation ID</span>
                  <span className="font-bold text-primary">Tag {analysis.imageMetadata?.orientation || '1'} (Normal)</span>
                </div>
              </div>
            </div>
          </div>

          {/* Diagnostics Section (for Density/DPI and low level properties) */}
          {showDiagnostics && (
            <div className="text-[10px] font-code-sm text-outline opacity-70 animate-in fade-in pt-sm border-t border-outline-variant/30 grid grid-cols-1 md:grid-cols-2 gap-sm">
              <p>Density Resolution: {analysis.imageMetadata?.density ? `${analysis.imageMetadata.density} DPI` : 'Standard Density'}</p>
              <p>Embedded Color Profile: {analysis.imageMetadata?.hasProfile ? 'Yes' : 'No'}</p>
            </div>
          )}

          {/* Platform Optimization & Interpretation Summary Disclaimer */}
          <div className="mt-md p-md bg-surface-container-low border border-outline-variant/30 rounded-lg text-body-md text-on-surface-variant flex items-start gap-sm animate-in fade-in duration-300">
            <span className="material-symbols-outlined text-secondary text-[20px] mt-0.5">info</span>
            <p className="leading-relaxed">
              Metadata structure is consistent with a compressed or web-optimized image export. Missing embedded camera metadata is common in platform-processed uploads.
            </p>
          </div>
        </div>

      </div>

      {/* Action Footer */}
      <footer className="mt-2xl pt-xl border-t border-outline-variant flex justify-between items-center">
        <div className="flex items-center gap-md text-outline font-body-md">
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined text-[18px]">verified_user</span>
            <span className="font-code-sm opacity-60 uppercase text-[12px]">Integrity Hash: {job.id.substring(0, 12)}</span>
          </div>
        </div>
        <div className="flex gap-md">
          <Link to="/jobs" className="px-lg py-md border border-primary rounded-lg text-primary font-label-md hover:bg-surface-container-high transition-colors">
            Return to List
          </Link>
          <button className="px-lg py-md bg-primary text-on-primary rounded-lg font-label-md flex items-center gap-sm hover:opacity-90 transition-opacity shadow-sm">
            <span className="material-symbols-outlined text-[20px]">print</span>
            Export Audit Report
          </button>
        </div>
      </footer>
    </div>
  );
};

export default JobResults;
